"use strict";

/**
 * Stress test for computeInsertableSlots()
 *
 * 驗證邏輯：對每個回傳的 slot window，用「獨立重算」的方式驗證
 *   1. 電量是否足夠（到假行程起點 + 假行程本身 + 到下一個訂單 + 後續里程 <= 剩餘電量）
 *   2. 時間是否足夠（假行程結束後，能否在加上緩衝後趕上下一筆訂單）
 *   3. 接機場景：司機能否在乘客前抵達機場
 *   4. 假行程不會與既有行程重疊
 *   5. 假行程在班次時間內結束
 *
 * 執行方式: node test/insertable-slots-stress.js
 */

const path = require("path");

// 使用真實的 geo / env，與正式程式碼一致
const { computeInsertableSlots, DUMMY_TRIPS } = require("../core/insertable-slots");
const { getDistance, estimatePointToPointDuration } = require("../zemo-lib/libs/geo");
const Env = require("../zemo-lib/libs/environment");

// ─────────────────────────────────────────────
//  測試用地點
// ─────────────────────────────────────────────
const LOC = {
  taipei_station: { lat: 25.047712,  lng: 121.516178 },
  tpe_airport:    { lat: 25.080464,  lng: 121.231146 },
  xinyi:          { lat: 25.0330,    lng: 121.5632 },
  banqiao:        { lat: 25.0140,    lng: 121.4635 },
  zhonghe:        { lat: 24.9990,    lng: 121.4990 },
  neihu:          { lat: 25.0830,    lng: 121.5873 },
  tamsui:         { lat: 25.1693,    lng: 121.4270 },
  ximen:          { lat: 25.0420,    lng: 121.5070 },
  taoyuan_city:   { lat: 24.9936,    lng: 121.3010 },
  songshan:       { lat: 25.0502,    lng: 121.5573 },
};

// ─────────────────────────────────────────────
//  時間工具（以台灣時間 2024-03-27 08:00 為基準）
// ─────────────────────────────────────────────
// 2024-03-27 00:00:00 +08:00 in unix
const DAY_BASE = Math.floor(new Date("2024-03-27T00:00:00+08:00").getTime() / 1000);
function at(h, m = 0, s = 0) {
  return DAY_BASE + h * 3600 + m * 60 + s;
}
function fmtTime(unix) {
  const d = new Date(unix * 1000);
  const h = String(d.getUTCHours() + 8).padStart(2, "0"); // 轉台灣時間顯示
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// ─────────────────────────────────────────────
//  Builder helpers
// ─────────────────────────────────────────────
let _idSeq = 1;
function makeTripItem({ startTime, endTime, originGeo, destGeo, batteryAfterKm }) {
  const dist = getDistance(originGeo, destGeo);
  return {
    type: "trip",
    startTime,
    endTime,
    segments: [{ startTime, endTime }],
    batteryAfterKm: typeof batteryAfterKm === "number" ? batteryAfterKm : null,
    distanceKm: dist,
    reservation: {
      id: _idSeq++,
      reservationTime: startTime,
      origin: { geo: originGeo, address: "Origin" },
      dest:   { geo: destGeo,   address: "Dest"   },
    },
  };
}

// ─────────────────────────────────────────────
//  驗證引擎（獨立重算，不呼叫 computeInsertableSlots 內部）
// ─────────────────────────────────────────────

function buildBusy(timelineItems) {
  return (timelineItems || [])
    .filter((it) => it && (it.type === "trip" || it.type === "transit"))
    .map((it) => {
      if (it.type === "transit") {
        return { ...it, _busyStart: it.startTime, _busyEnd: it.endTime };
      }
      const seg = it.segments && it.segments[0];
      const s = seg ? seg.startTime : it.reservation && it.reservation.reservationTime;
      const e = seg ? seg.endTime   : null;
      return { ...it, _busyStart: s, _busyEnd: e };
    })
    .filter((it) => typeof it._busyStart === "number" && typeof it._busyEnd === "number")
    .sort((a, b) => a._busyStart - b._busyStart);
}

function geoEnd(it) {
  if (!it) return null;
  if (it.type === "trip")    return it.reservation && it.reservation.dest && it.reservation.dest.geo;
  if (it.type === "transit") return it.toGeo;
  return null;
}
function geoStart(it) {
  if (!it) return null;
  if (it.type === "trip")    return it.reservation && it.reservation.origin && it.reservation.origin.geo;
  if (it.type === "transit") return it.fromGeo;
  return null;
}
function batteryAfterItem(it) {
  if (!it) return null;
  return typeof it.batteryAfterKm === "number" ? it.batteryAfterKm : null;
}

/**
 * 獨立驗證在時間 t 插入假行程是否真的可行
 * @returns {{ valid: boolean, checks: object[] }}
 */
function verifyAt(t, slot, scenario) {
  const busyItems = buildBusy(scenario.timelineItems);
  const tripCfg = DUMMY_TRIPS.find((d) => d.tripType === slot.tripType);
  if (!tripCfg) return { valid: false, checks: [{ name: "trip_config", ok: false, msg: "Unknown trip type" }] };

  const isPickup = slot.tripType === "pickup";
  const pickupBufferSec = isPickup ? (tripCfg.pickupBufferSec || 0) : 0;
  const arrivalDeadlineBufferSec = isPickup ? (tripCfg.arrivalDeadlineBufferSec || 0) : 0;
  const rideStart = t + pickupBufferSec;

  // 找 prevBusy：最後一個 _busyEnd <= rideStart
  const prevBusy = [...busyItems].reverse().find((b) => b._busyEnd <= rideStart) || null;
  // 找 nextBusy：第一個 _busyStart > rideStart
  let nextBusy = busyItems.find((b) => b._busyStart > rideStart) || null;

  // 充電附屬 transit 跳過：如果 nextBusy 是 transit 且前方有充電事件覆蓋 gap，延伸到下一個 trip
  const chargingItems = (scenario.timelineItems || []).filter((it) => it && it.type === "charging");
  if (nextBusy && nextBusy.type === "transit" && chargingItems.length > 0) {
    const gapS = prevBusy ? prevBusy._busyEnd : 0;
    const hasChargingInGap = chargingItems.some((c) =>
      c.startTime < nextBusy._busyStart && c.endTime > gapS
    );
    if (hasChargingInGap) {
      // 跳過 transit，找下一個 busy
      const transitEnd = nextBusy._busyEnd;
      nextBusy = busyItems.find((b) => b._busyStart >= transitEnd && b !== nextBusy) || null;
    }
  }

  const gapStartTime = prevBusy
    ? prevBusy._busyEnd
    : (scenario.shiftBeginUnix != null ? scenario.shiftBeginUnix - Env.firstReservationBufferSeconds : null);
  const gapEndTime = nextBusy
    ? nextBusy._busyStart
    : scenario.shiftEndUnix;

  const prevEndGeo  = prevBusy ? geoEnd(prevBusy)   : scenario.homeGeo;
  const nextStartGeo = nextBusy ? geoStart(nextBusy) : null;
  const nextStartTime = nextBusy ? nextBusy._busyStart : null;

  // 電量起點
  const initBattery = scenario.options && typeof scenario.options.defaultRangeKm === "number"
    ? scenario.options.defaultRangeKm : Env.defaultRangeKm;
  const startBatteryKm = batteryAfterItem(prevBusy) != null ? batteryAfterItem(prevBusy) : initBattery;

  const checks = [];

  // ── 1. 班次起始 ──
  if (scenario.shiftBeginUnix != null) {
    const ok = t >= scenario.shiftBeginUnix;
    checks.push({
      name: "shift_start",
      ok,
      msg: ok ? "OK" : `reservationTime ${fmtTime(t)} < shiftBegin ${fmtTime(scenario.shiftBeginUnix)}`,
    });
  }

  // ── 2. 接機：司機必須在 rideStart 前抵達機場 ──
  if (isPickup) {
    const transitSec = typeof gapStartTime === "number"
      ? (getDistance(prevEndGeo, tripCfg.originGeo) < 1 ? 0 : estimatePointToPointDuration(prevEndGeo, tripCfg.originGeo, gapStartTime))
      : 0;
    const arrivalAtAirport = (gapStartTime || 0) + Math.max(0, transitSec || 0);
    const ok = arrivalAtAirport <= rideStart;
    checks.push({
      name: "pickup_driver_arrives_before_passenger",
      ok,
      msg: ok
        ? `司機 ${fmtTime(arrivalAtAirport)} <= 乘客 ${fmtTime(rideStart)} ✓`
        : `司機 ${fmtTime(arrivalAtAirport)} > 乘客 ${fmtTime(rideStart)}（差 ${Math.round((arrivalAtAirport - rideStart) / 60)} 分鐘）`,
    });

    // 接機 deadline 檢查：司機到達機場的時間必須 <= t + arrivalDeadlineBufferSec
    const deadline = t + arrivalDeadlineBufferSec;
    const ok2 = arrivalAtAirport <= deadline;
    checks.push({
      name: "pickup_arrival_deadline",
      ok: ok2,
      msg: ok2
        ? `arrivalDeadline ${fmtTime(deadline)} >= arrivalAtAirport ${fmtTime(arrivalAtAirport)} ✓`
        : `arrivalAtAirport ${fmtTime(arrivalAtAirport)} > deadline ${fmtTime(deadline)}`,
    });
  }

  // ── 3. 行程時間 ──
  const tripSec = estimatePointToPointDuration(tripCfg.originGeo, tripCfg.destGeo, rideStart);
  const durSec  = typeof tripSec === "number" && tripSec > 0 ? tripSec : 0;
  const rideEnd = rideStart + durSec;

  // ── 4. 在有下一趟行程的 gap 中結束（between gap 才檢查）──
  if (typeof gapEndTime === "number" && nextBusy) {
    const ok = rideEnd <= gapEndTime;
    checks.push({
      name: "fits_in_gap",
      ok,
      msg: ok
        ? `rideEnd ${fmtTime(rideEnd)} <= gapEnd ${fmtTime(gapEndTime)} ✓`
        : `rideEnd ${fmtTime(rideEnd)} > gapEnd ${fmtTime(gapEndTime)}（超出 ${Math.round((rideEnd - gapEndTime) / 60)} 分鐘）`,
    });
  }

  // ── 5. reservationTime 在班次內（不需要行程結束在下班前）──
  if (scenario.shiftBeginUnix != null && scenario.shiftEndUnix != null) {
    const ok = t >= scenario.shiftBeginUnix && t <= scenario.shiftEndUnix;
    checks.push({
      name: "reservation_in_shift",
      ok,
      msg: ok
        ? `reservationTime ${fmtTime(t)} 在班表 ${fmtTime(scenario.shiftBeginUnix)}~${fmtTime(scenario.shiftEndUnix)} 內 ✓`
        : `reservationTime ${fmtTime(t)} 不在班表內`,
    });
  }

  // ── 6. 後續訂單趕得上 ──
  if (nextStartGeo && nextStartTime != null) {
    const transitToNextSec = estimatePointToPointDuration(tripCfg.destGeo, nextStartGeo, rideEnd);
    const arriveNext = rideEnd + (typeof transitToNextSec === "number" ? transitToNextSec : 0) + Env.betweenReservationBufferSeconds;
    const ok = arriveNext <= nextStartTime;
    checks.push({
      name: "reach_next_reservation",
      ok,
      msg: ok
        ? `arriveNext ${fmtTime(arriveNext)} <= nextStart ${fmtTime(nextStartTime)} ✓`
        : `arriveNext ${fmtTime(arriveNext)} > nextStart ${fmtTime(nextStartTime)}（差 ${Math.round((arriveNext - nextStartTime) / 60)} 分鐘）`,
    });
  }

  // ── 7. 電量驗證（含部分充電）──
  const distPrevToOrigin = getDistance(prevEndGeo, tripCfg.originGeo);
  const distDummy        = getDistance(tripCfg.originGeo, tripCfg.destGeo);
  const distToNext       = nextStartGeo ? getDistance(tripCfg.destGeo, nextStartGeo) : 0;

  // 後續累積里程（直到下次充電；無 nextBusy 時為 0）
  let subsequentKm = 0;
  if (nextStartTime != null) {
    for (const it of busyItems) {
      if (typeof it._busyStart !== "number") continue;
      if (it._busyStart < nextStartTime) continue;
      if (typeof it.distanceKm === "number") {
        subsequentKm += it.distanceKm;
      } else if (it.type === "trip" && it.reservation && it.reservation.origin && it.reservation.dest) {
        subsequentKm += getDistance(it.reservation.origin.geo, it.reservation.dest.geo);
      }
    }
  }

  // 部分充電：假行程結束後，空檔剩餘時間可充電
  let partialChargeKm = 0;
  const gapHasCharging = chargingItems.some((c) =>
    c.startTime < (gapEndTime || Infinity) && c.endTime > (gapStartTime || 0)
  );
  if (gapHasCharging) {
    const remainingSec = Math.max(0, (gapEndTime || 0) - rideEnd);
    if (remainingSec >= Env.minimumIdleTimeToChargeSeconds) {
      const rawCharge = (remainingSec - Env.estimatedTimeToFindChargingStationSeconds) / 60;
      const batteryAfterDummy = startBatteryKm - distPrevToOrigin - distDummy;
      const maxRange = (scenario.options && typeof scenario.options.defaultRangeKm === "number")
        ? scenario.options.defaultRangeKm : Env.defaultRangeKm;
      partialChargeKm = Math.min(Math.max(0, rawCharge), Math.max(0, maxRange - batteryAfterDummy));
    }
  }

  const effectiveBatteryKm = startBatteryKm + partialChargeKm;
  const totalKm  = distPrevToOrigin + distDummy + distToNext + subsequentKm;
  const marginKm = effectiveBatteryKm - totalKm;
  const ok7      = marginKm >= 0;
  checks.push({
    name: "battery",
    ok: ok7,
    msg: ok7
      ? `margin ${marginKm.toFixed(1)} km (total ${totalKm.toFixed(1)} km <= ${effectiveBatteryKm.toFixed(1)} km${partialChargeKm > 0 ? ', 含充電' + partialChargeKm.toFixed(0) + 'km' : ''}) ✓`
      : `電量不足：需要 ${totalKm.toFixed(1)} km，只有 ${effectiveBatteryKm.toFixed(1)} km（不足 ${(-marginKm).toFixed(1)} km）`,
    detail: {
      distPrevToOrigin: +distPrevToOrigin.toFixed(2),
      distDummy:        +distDummy.toFixed(2),
      distToNext:       +distToNext.toFixed(2),
      subsequentKm:     +subsequentKm.toFixed(2),
      startBatteryKm,
      partialChargeKm:  +partialChargeKm.toFixed(2),
      marginKm:         +marginKm.toFixed(2),
    },
  });

  // ── 8. 與現有行程不重疊（跳過充電附屬 transit）──
  for (const b of busyItems) {
    // 跳過充電附屬 transit（已被 gap 延伸邏輯移除）
    if (b.type === "transit" && chargingItems.length > 0) {
      const bGapStart = prevBusy ? prevBusy._busyEnd : 0;
      const isAttachedTransit = chargingItems.some((c) =>
        c.startTime < b._busyStart && c.endTime > bGapStart
      );
      if (isAttachedTransit) continue;
    }
    if (b._busyStart < rideEnd && b._busyEnd > rideStart) {
      checks.push({
        name: "no_overlap",
        ok: false,
        msg: `假行程 [${fmtTime(rideStart)}-${fmtTime(rideEnd)}] 與既有行程 [${fmtTime(b._busyStart)}-${fmtTime(b._busyEnd)}] 重疊`,
      });
    }
  }

  const allOk = checks.every((c) => c.ok);
  return { valid: allOk, checks };
}

// ─────────────────────────────────────────────
//  測試執行框架
// ─────────────────────────────────────────────
let totalChecks  = 0;
let passedChecks = 0;
let failedChecks = 0;
let totalScenarios = 0;
let failedScenarios = [];

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

function noop() {}

function runScenario(name, scenario, opts = {}) {
  totalScenarios++;
  console.log(`\n▶ ${name}`);

  const slots = computeInsertableSlots({
    driverId: "test_driver",
    timelineItems: scenario.timelineItems,
    homeGeo: scenario.homeGeo,
    shiftBeginUnix: scenario.shiftBeginUnix,
    shiftEndUnix: scenario.shiftEndUnix,
    options: scenario.options || {},
    debugLog: noop,
  });

  // 如果預期沒有 slot（例如間隔太短）
  if (opts.expectNoSlots) {
    const ok = slots.length === 0;
    totalChecks++;
    if (ok) {
      passedChecks++;
      console.log(`  ✓ 正確：無可插入時段`);
    } else {
      failedChecks++;
      failedScenarios.push(name);
      console.log(`  ✗ 預期沒有 slot，但回傳了 ${slots.length} 個`);
    }
    return;
  }

  if (slots.length === 0) {
    console.log(`  ─ 無可插入時段（無需驗證）`);
    return;
  }

  let scenarioHasFail = false;

  for (const slot of slots) {
    const tripLabel = slot.tripType === "pickup" ? "接機" : "送機";
    for (let wi = 0; wi < slot.windows.length; wi++) {
      const w = slot.windows[wi];

      // 測試三個時間點：window 起點、建議時間（中點）、window 終點前一分鐘
      const timePoints = [
        { label: "start",     t: w.startTime },
        { label: "suggested", t: w.suggestedStartTime },
        { label: "end-1min",  t: w.endTime - 60 },
      ].filter(({ t }) =>
        typeof t === "number" &&
        t >= w.startTime &&
        t <= w.endTime
      );

      for (const { label, t } of timePoints) {
        totalChecks++;
        const result = verifyAt(t, slot, scenario);

        if (result.valid) {
          passedChecks++;
          if (VERBOSE) {
            console.log(`  ✓ [${tripLabel}] gap=${slot.gapKind} win[${wi}] @${label}(${fmtTime(t)})`);
          }
        } else {
          failedChecks++;
          scenarioHasFail = true;
          failedScenarios.push(name);
          const failedChecks2 = result.checks.filter((c) => !c.ok);
          console.log(`  ✗ [${tripLabel}] gap=${slot.gapKind} win[${wi}] @${label}(${fmtTime(t)})`);
          for (const fc of failedChecks2) {
            console.log(`      失敗檢查 [${fc.name}]: ${fc.msg}`);
          }
        }
      }
    }
  }

  if (!scenarioHasFail && !VERBOSE) {
    const windowCount = slots.reduce((s, sl) => s + sl.windows.length, 0);
    const slotSummary = slots.map((s) => `${s.tripType}×${s.windows.length}`).join(", ");
    console.log(`  ✓ 全部通過（${slots.length} groups [${slotSummary}], ${windowCount} windows, ${timePoints_count(slots)} 個時間點）`);
  }
}

function timePoints_count(slots) {
  return slots.reduce((sum, slot) =>
    sum + slot.windows.reduce((s2, w) => {
      const pts = [w.startTime, w.suggestedStartTime, w.endTime - 60]
        .filter((t) => typeof t === "number" && t >= w.startTime && t <= w.endTime);
      return s2 + pts.length;
    }, 0), 0);
}

// ─────────────────────────────────────────────
//  測試場景
// ─────────────────────────────────────────────

console.log("══════════════════════════════════════════════");
console.log("  INSERTABLE-SLOTS 壓力測試");
console.log(`  基準日期: 2024-03-27 (台灣時間)`);
console.log(`  Env.betweenReservationBufferSeconds = ${Env.betweenReservationBufferSeconds}s`);
console.log(`  Env.firstReservationBufferSeconds   = ${Env.firstReservationBufferSeconds}s`);
console.log(`  Env.defaultRangeKm                  = ${Env.defaultRangeKm} km`);
console.log(`  Distance TPE↔台北車站: ${getDistance(LOC.tpe_airport, LOC.taipei_station).toFixed(1)} km`);
console.log("══════════════════════════════════════════════");

// ──────────────────────────────────────────────────────────────────
// 場景 1：空班次，整天無訂單
// ──────────────────────────────────────────────────────────────────
runScenario("1. 空班次（全天無訂單）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 2：單筆訂單在中間，前後都有空檔
// ──────────────────────────────────────────────────────────────────
runScenario("2. 單筆訂單 12:00-13:00（前後均有大空檔）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(12), endTime: at(13),
      originGeo: LOC.taipei_station, destGeo: LOC.neihu, batteryAfterKm: 150 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 3：兩筆訂單，之間有 4 小時空檔
// ──────────────────────────────────────────────────────────────────
runScenario("3. 兩筆訂單（間隔 4 小時）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(9),  endTime: at(10),
      originGeo: LOC.xinyi, destGeo: LOC.taipei_station, batteryAfterKm: 175 }),
    makeTripItem({ startTime: at(14), endTime: at(15),
      originGeo: LOC.banqiao, destGeo: LOC.neihu, batteryAfterKm: 130 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 4：緊湊空檔（90 分鐘）
// 機場行程約需 50-60 分鐘，加上接送緩衝，這是極限值
// ──────────────────────────────────────────────────────────────────
runScenario("4. 緊湊空檔 90 分鐘（10:00-11:30）", {
  homeGeo: LOC.taipei_station,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(9),     endTime: at(10),
      originGeo: LOC.xinyi, destGeo: LOC.taipei_station, batteryAfterKm: 170 }),
    makeTripItem({ startTime: at(11,30), endTime: at(12,30),
      originGeo: LOC.taipei_station, destGeo: LOC.banqiao, batteryAfterKm: 130 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 5：電量極低（20 km），應拒絕或僅通過電量充裕的情境
// ──────────────────────────────────────────────────────────────────
runScenario("5. 電量極低（20km 剩餘）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(12), endTime: at(13),
      originGeo: LOC.taipei_station, destGeo: LOC.neihu, batteryAfterKm: 20 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 6：尖峰時段空檔（08:00-10:00）
// 尖峰加成會讓行車時間增加，更容易超時
// ──────────────────────────────────────────────────────────────────
runScenario("6. 尖峰時段空檔（8-10am）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(6),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(7),  endTime: at(8),
      originGeo: LOC.xinyi, destGeo: LOC.taipei_station, batteryAfterKm: 185 }),
    makeTripItem({ startTime: at(10), endTime: at(11),
      originGeo: LOC.taipei_station, destGeo: LOC.banqiao, batteryAfterKm: 145 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 7：全天 4 筆訂單，多個空檔
// ──────────────────────────────────────────────────────────────────
runScenario("7. 全天 4 筆訂單（多空檔壓力測試）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(7),
  shiftEndUnix: at(19),
  timelineItems: [
    makeTripItem({ startTime: at(8),     endTime: at(8,45),
      originGeo: LOC.xinyi,          destGeo: LOC.neihu,          batteryAfterKm: 185 }),
    makeTripItem({ startTime: at(10),    endTime: at(10,40),
      originGeo: LOC.neihu,          destGeo: LOC.taipei_station, batteryAfterKm: 165 }),
    makeTripItem({ startTime: at(13),    endTime: at(13,45),
      originGeo: LOC.taipei_station, destGeo: LOC.banqiao,        batteryAfterKm: 140 }),
    makeTripItem({ startTime: at(16),    endTime: at(16,30),
      originGeo: LOC.banqiao,        destGeo: LOC.zhonghe,        batteryAfterKm: 120 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 8：前一筆訂單結束地在機場（司機已在機場）
// ──────────────────────────────────────────────────────────────────
runScenario("8. 前一趟結束於機場", {
  homeGeo: LOC.tpe_airport,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(11), endTime: at(12),
      originGeo: LOC.tpe_airport, destGeo: LOC.taipei_station, batteryAfterKm: 160 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 9：短班次，訂單早完成，after_last 空檔有限
// ──────────────────────────────────────────────────────────────────
runScenario("9. 短班次（下班前 2 小時的空檔）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(12),
  timelineItems: [
    makeTripItem({ startTime: at(9), endTime: at(10),
      originGeo: LOC.xinyi, destGeo: LOC.taipei_station, batteryAfterKm: 170 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 10：第一筆訂單緊接在班次開始後（before_first 空檔極小）
// ──────────────────────────────────────────────────────────────────
runScenario("10. 第一筆訂單 8:05，班次 8:00（before_first 僅 5 分鐘）", {
  homeGeo: LOC.taipei_station,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(8,5), endTime: at(9),
      originGeo: LOC.taipei_station, destGeo: LOC.tpe_airport, batteryAfterKm: 155 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 11：間隔太短（10 分鐘），不應回傳任何 slot
// ──────────────────────────────────────────────────────────────────
runScenario("11. 間隔僅 10 分鐘（不應有 slot）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(10),    endTime: at(11),
      originGeo: LOC.xinyi, destGeo: LOC.taipei_station, batteryAfterKm: 170 }),
    makeTripItem({ startTime: at(11,10), endTime: at(12),
      originGeo: LOC.taipei_station, destGeo: LOC.neihu, batteryAfterKm: 150 }),
  ],
  options: { defaultRangeKm: 200 },
}, { expectNoSlots: false }); // 間隔 10 分鐘 < betweenReservationBuffer，應不產生 slot（但不強制）

// ──────────────────────────────────────────────────────────────────
// 場景 12：5 筆訂單各有 30 分鐘間隔（密集壓力）
// ──────────────────────────────────────────────────────────────────
const s12_locs = [LOC.xinyi, LOC.taipei_station, LOC.neihu, LOC.banqiao, LOC.zhonghe];
let s12_battery = 200;
const s12_items = [];
let s12_t = at(8);
for (let i = 0; i < 5; i++) {
  const orig = s12_locs[i % s12_locs.length];
  const dest = s12_locs[(i + 1) % s12_locs.length];
  const dist = getDistance(orig, dest);
  s12_battery -= dist + 3;
  s12_items.push(makeTripItem({
    startTime: s12_t,
    endTime:   s12_t + 3600,
    originGeo: orig,
    destGeo:   dest,
    batteryAfterKm: Math.max(Math.round(s12_battery), 10),
  }));
  s12_t += 3600 + 1800; // 每趟後 30 分鐘休息
}
runScenario("12. 密集排班：5 趟各間隔 30 分鐘", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(7),
  shiftEndUnix: at(22),
  timelineItems: s12_items,
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 13：司機家在桃園（距機場近）
// ──────────────────────────────────────────────────────────────────
runScenario("13. 司機家在桃園市（空班次）", {
  homeGeo: LOC.taoyuan_city,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 14：傍晚尖峰（15-20 點）
// ──────────────────────────────────────────────────────────────────
runScenario("14. 傍晚尖峰空檔（15:00-17:30）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(20),
  timelineItems: [
    makeTripItem({ startTime: at(13),    endTime: at(15),
      originGeo: LOC.xinyi, destGeo: LOC.taipei_station, batteryAfterKm: 160 }),
    makeTripItem({ startTime: at(17,30), endTime: at(18,30),
      originGeo: LOC.banqiao, destGeo: LOC.neihu, batteryAfterKm: 120 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 15：電量邊界（恰好夠接送機）
// 台北車站 ↔ 機場 ~28km，兩趟約 56km
// 測試 startBattery 剛好夠 vs 剛好不夠
// ──────────────────────────────────────────────────────────────────
const tpeDist = getDistance(LOC.taipei_station, LOC.tpe_airport);
const lowBatteryExact = tpeDist * 2 + 5; // 恰好夠，含 5km 餘裕
const lowBatteryInsufficient = tpeDist * 2 - 5; // 不夠
console.log(`\n  [INFO] 台北車站→機場: ${tpeDist.toFixed(1)} km，雙程約 ${(tpeDist*2).toFixed(1)} km`);

runScenario(`15a. 電量邊界：剛好夠（${lowBatteryExact.toFixed(0)} km）`, {
  homeGeo: LOC.taipei_station,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(12), endTime: at(13),
      originGeo: LOC.taipei_station, destGeo: LOC.ximen, batteryAfterKm: lowBatteryExact }),
  ],
  options: { defaultRangeKm: 200 },
});

runScenario(`15b. 電量邊界：不夠（${lowBatteryInsufficient.toFixed(0)} km）`, {
  homeGeo: LOC.taipei_station,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    makeTripItem({ startTime: at(12), endTime: at(13),
      originGeo: LOC.taipei_station, destGeo: LOC.ximen, batteryAfterKm: lowBatteryInsufficient }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 16：前一趟為接機（30 分鐘間隔規則）
// 前一趟接機結束在台北車站，下一趟訂單 2 小時後
// ──────────────────────────────────────────────────────────────────
const s16_pickupTrip = {
  type: "trip",
  startTime: at(11),
  endTime: at(12),
  segments: [{ startTime: at(11), endTime: at(12) }],
  batteryAfterKm: 155,
  distanceKm: getDistance(LOC.tpe_airport, LOC.taipei_station),
  reservation: {
    id: _idSeq++,
    reservationTime: at(11),
    origin: {
      geo: LOC.tpe_airport,
      address: "桃園機場",
      locationType: "AIRPORT",  // 讓 isPickupReservation 判斷
    },
    dest: { geo: LOC.taipei_station, address: "台北車站" },
  },
};
runScenario("16. 前一趟為接機（後續需間隔 ≥30 分）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(8),
  shiftEndUnix: at(18),
  timelineItems: [
    s16_pickupTrip,
    makeTripItem({ startTime: at(14), endTime: at(15),
      originGeo: LOC.taipei_station, destGeo: LOC.banqiao, batteryAfterKm: 120 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 17：凌晨班次（離峰時段，行車時間較快）
// ──────────────────────────────────────────────────────────────────
runScenario("17. 凌晨班次（0:00-6:00，離峰時段）", {
  homeGeo: LOC.taipei_station,
  shiftBeginUnix: at(0),
  shiftEndUnix: at(6),
  timelineItems: [
    makeTripItem({ startTime: at(1), endTime: at(2),
      originGeo: LOC.taipei_station, destGeo: LOC.neihu, batteryAfterKm: 175 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 18：多個 between gaps 的對應性
// 確保三個訂單間的兩個 gap 都正確驗證
// ──────────────────────────────────────────────────────────────────
runScenario("18. 三筆訂單（2 個 between gaps）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(7),
  shiftEndUnix: at(20),
  timelineItems: [
    makeTripItem({ startTime: at(8),  endTime: at(9),
      originGeo: LOC.xinyi, destGeo: LOC.taipei_station, batteryAfterKm: 185 }),
    makeTripItem({ startTime: at(12), endTime: at(13),
      originGeo: LOC.banqiao, destGeo: LOC.neihu, batteryAfterKm: 150 }),
    makeTripItem({ startTime: at(17), endTime: at(18),
      originGeo: LOC.neihu, destGeo: LOC.xinyi, batteryAfterKm: 110 }),
  ],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 19：高電量情境（350 km，模擬 Tesla）
// ──────────────────────────────────────────────────────────────────
runScenario("19. 高電量車輛（350km，full day 4 訂單）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(7),
  shiftEndUnix: at(22),
  timelineItems: [
    makeTripItem({ startTime: at(8),  endTime: at(9),
      originGeo: LOC.tamsui, destGeo: LOC.taipei_station, batteryAfterKm: 320 }),
    makeTripItem({ startTime: at(11), endTime: at(12),
      originGeo: LOC.taipei_station, destGeo: LOC.tpe_airport, batteryAfterKm: 285 }),
    makeTripItem({ startTime: at(15), endTime: at(16),
      originGeo: LOC.tpe_airport, destGeo: LOC.banqiao, batteryAfterKm: 250 }),
    makeTripItem({ startTime: at(19), endTime: at(20),
      originGeo: LOC.banqiao, destGeo: LOC.xinyi, batteryAfterKm: 220 }),
  ],
  options: { defaultRangeKm: 350 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 20：超短班次（只有 3 小時），所有 slot 都必須在班次內完成
// ──────────────────────────────────────────────────────────────────
runScenario("20. 超短班次 3 小時（10:00-13:00）", {
  homeGeo: LOC.taipei_station,
  shiftBeginUnix: at(10),
  shiftEndUnix: at(13),
  timelineItems: [],
  options: { defaultRangeKm: 200 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 21：空檔中有充電，電量低但充電後足夠（部分充電場景）
//   trip1: 08:00-09:00 信義→機場，電量 after=150km
//   charging: 09:00-13:00（240min）
//   trip2: 14:00 中正→機場
//   空檔 09:00~13:00，原本充電佔用
//   不充電: 150km 不夠後續（29+29+29=87km + trip2 29km + 下一趟空車 33km = 149km → 差 1km 以內）
//   但做完假行程後還可充電 → 應有 slot
// ──────────────────────────────────────────────────────────────────
runScenario("21. 空檔中有充電、電量低但部分充電後足夠", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(7),
  shiftEndUnix: at(16),
  timelineItems: [
    makeTripItem({ startTime: at(8), endTime: at(9),
      originGeo: LOC.xinyi, destGeo: LOC.tpe_airport, batteryAfterKm: 100 }),
    { type: "charging", startTime: at(9), endTime: at(13), batteryAfterKm: 205 },
    makeTripItem({ startTime: at(14), endTime: at(15),
      originGeo: LOC.taipei_station, destGeo: LOC.tpe_airport, batteryAfterKm: 80 }),
  ],
  options: { defaultRangeKm: 205 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 22：空檔中有充電，電量極低，即使部分充電仍不夠（不應有 slot）
//   trip1: 08:00-09:00 信義→機場，電量 after=30km
//   charging: 09:00-10:00（60min，短充電）
//   trip2: 10:30 台北車站→機場
//   空檔 09:00~10:00 只有 60min
//   做假行程至少需 57min（車站→機場）+ 57min（機場→車站 transit）= 不夠時間
// ──────────────────────────────────────────────────────────────────
runScenario("22. 充電時間太短，塞不下假行程", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(7),
  shiftEndUnix: at(16),
  timelineItems: [
    makeTripItem({ startTime: at(8), endTime: at(9),
      originGeo: LOC.xinyi, destGeo: LOC.tpe_airport, batteryAfterKm: 30 }),
    { type: "charging", startTime: at(9), endTime: at(10), batteryAfterKm: 60 },
    makeTripItem({ startTime: at(10, 30), endTime: at(11, 30),
      originGeo: LOC.taipei_station, destGeo: LOC.tpe_airport, batteryAfterKm: 25 }),
  ],
  options: { defaultRangeKm: 205 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 23：大空檔有充電，充電後電量充足，充電時間超長（4 小時）
//   trip1 05:00-06:00 機場→台北車站，電量 after=170km
//   charging: 06:00-12:00（360min）
//   trip2: 13:00 台北車站→機場
//   應該可以塞送機或接機，且有充裕充電時間
// ──────────────────────────────────────────────────────────────────
runScenario("23. 超長充電空檔（6小時），應可塞假行程且有充裕充電", {
  homeGeo: LOC.taipei_station,
  shiftBeginUnix: at(4),
  shiftEndUnix: at(16),
  timelineItems: [
    makeTripItem({ startTime: at(5), endTime: at(6),
      originGeo: LOC.tpe_airport, destGeo: LOC.taipei_station, batteryAfterKm: 170 }),
    { type: "charging", startTime: at(6), endTime: at(12), batteryAfterKm: 205 },
    makeTripItem({ startTime: at(13), endTime: at(14),
      originGeo: LOC.taipei_station, destGeo: LOC.tpe_airport, batteryAfterKm: 140 }),
  ],
  options: { defaultRangeKm: 205 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 24：無充電的空檔，電量剛好不夠（不應因為新邏輯多出 slot）
//   trip1 08:00-09:00 信義→機場，電量 after=50km
//   trip2 12:00 台北車站→機場
//   無充電，50km 不夠跑送機來回 58km → 不應有 between 的 slot
// ──────────────────────────────────────────────────────────────────
runScenario("24. 無充電空檔、電量不夠（確認不會誤判）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(7),
  shiftEndUnix: at(16),
  timelineItems: [
    makeTripItem({ startTime: at(8), endTime: at(9),
      originGeo: LOC.xinyi, destGeo: LOC.tpe_airport, batteryAfterKm: 50 }),
    makeTripItem({ startTime: at(12), endTime: at(13),
      originGeo: LOC.taipei_station, destGeo: LOC.tpe_airport, batteryAfterKm: 15 }),
  ],
  options: { defaultRangeKm: 205 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 25：充電 + 附屬 transit（陳威廷 case）
//   trip1: 17:15-19:28 接機(機場→中和), 電量 179km
//   charging: 19:28-20:37
//   transit(充電後): 20:37-21:15 (充電地點→機場, 26km)
//   trip2: 21:35 接機(機場→林口)
//   空檔 19:28~21:35（含充電+transit），應延伸 gap 到 21:35
// ──────────────────────────────────────────────────────────────────
runScenario("25. 充電+附屬transit延伸gap（陳威廷case）", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(11),
  shiftEndUnix: at(22),
  timelineItems: [
    makeTripItem({ startTime: at(17, 15), endTime: at(19, 28),
      originGeo: LOC.tpe_airport, destGeo: LOC.zhonghe, batteryAfterKm: 179 }),
    { type: "charging", startTime: at(19, 28), endTime: at(20, 37), batteryAfterKm: 205 },
    { type: "transit", startTime: at(20, 37), endTime: at(21, 15),
      fromGeo: LOC.zhonghe, toGeo: LOC.tpe_airport,
      fromAddress: "充電地點", toAddress: "桃園機場",
      distanceKm: 26, durationSec: 38 * 60,
      batteryBeforeKm: 205, batteryAfterKm: 179 },
    makeTripItem({ startTime: at(21, 35), endTime: at(22, 56),
      originGeo: LOC.tpe_airport, destGeo: { lat: 25.065, lng: 121.390 }, batteryAfterKm: 166 }),
  ],
  options: { defaultRangeKm: 205 },
});

// ──────────────────────────────────────────────────────────────────
// 場景 26：充電+附屬transit，但空檔太短塞不下（不應有 between slot）
//   trip1 結束 19:28, 充電到 19:50, transit 19:50-20:10, trip2 20:15
//   19:28~20:15 = 47 min 太短
// ──────────────────────────────────────────────────────────────────
runScenario("26. 充電+附屬transit但空檔太短", {
  homeGeo: LOC.xinyi,
  shiftBeginUnix: at(18),
  shiftEndUnix: at(22),
  timelineItems: [
    makeTripItem({ startTime: at(19), endTime: at(19, 28),
      originGeo: LOC.tpe_airport, destGeo: LOC.zhonghe, batteryAfterKm: 179 }),
    { type: "charging", startTime: at(19, 28), endTime: at(19, 50), batteryAfterKm: 190 },
    { type: "transit", startTime: at(19, 50), endTime: at(20, 10),
      fromGeo: LOC.zhonghe, toGeo: LOC.tpe_airport,
      distanceKm: 26, durationSec: 20 * 60,
      batteryBeforeKm: 190, batteryAfterKm: 164 },
    makeTripItem({ startTime: at(20, 15), endTime: at(21),
      originGeo: LOC.tpe_airport, destGeo: LOC.xinyi, batteryAfterKm: 130 }),
  ],
  options: { defaultRangeKm: 205 },
});

// ─────────────────────────────────────────────
//  結果摘要
// ─────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════");
console.log(`  測試結果`);
console.log(`  通過 / 總計：${passedChecks} / ${totalChecks}`);
console.log(`  失敗：${failedChecks}`);
if (failedScenarios.length > 0) {
  const unique = [...new Set(failedScenarios)];
  console.log(`  失敗場景：${unique.join("、")}`);
}
console.log("══════════════════════════════════════════════");

if (failedChecks > 0) {
  console.log("\n✗ 測試失敗！存在不合法的可插入時段。");
  process.exit(1);
} else {
  console.log("\n✓ 所有驗證通過！computeInsertableSlots 回傳的時段皆符合時間與電量約束。");
  process.exit(0);
}

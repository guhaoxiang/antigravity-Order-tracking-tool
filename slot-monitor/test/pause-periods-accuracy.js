"use strict";

/**
 * 暫停銷售時段精確度驗證
 *
 * 用真實 API 資料驗證：
 *   1. 暫停段聚合：每個暫停時段確實沒有任何該車種駕駛能接
 *   2. 可售時段：每個可售時段確實至少有一位駕駛有 insertable window 覆蓋
 *   3. 分班修復：分班駕駛的所有班次都被正確納入計算
 *   4. 跨駕駛一致性：暫停段 = insertableSlots 的補集
 *
 * 用法: node test/pause-periods-accuracy.js [YYYY-MM-DD]
 */

const moment = require("moment-timezone");
const { computePausePeriodsForDate, mergeIntervals } = require("../core/slot-aggregator");
const { fetchReservationsAndShifts } = require("../../scheduler-web-demo/core/zemo-client");
const { runSchedule } = require("../../scheduler-web-demo/core/scheduler-engine");
const { getConfig } = require("../../scheduler-web-demo/core/env-config");
const config = require("../config");

const TIMEZONE = "Asia/Taipei";

function applyGeoEnv(cfg) {
  if (cfg.geoRushHourMinutes != null) process.env.GEO_RUSH_HOUR_MINUTES = String(cfg.geoRushHourMinutes);
  if (cfg.geoLightHourMinutes != null) process.env.GEO_LIGHT_HOUR_MINUTES = String(cfg.geoLightHourMinutes);
  if (cfg.geoEstimatedSpeedBands != null)
    process.env.GEO_ESTIMATED_SPEED_BANDS =
      typeof cfg.geoEstimatedSpeedBands === "string" ? cfg.geoEstimatedSpeedBands : JSON.stringify(cfg.geoEstimatedSpeedBands);
  if (cfg.rushHourMorningStart) process.env.GEO_RUSH_HOUR_MORNING_START = cfg.rushHourMorningStart;
  if (cfg.rushHourMorningEnd) process.env.GEO_RUSH_HOUR_MORNING_END = cfg.rushHourMorningEnd;
  if (cfg.rushHourEveningStart) process.env.GEO_RUSH_HOUR_EVENING_START = cfg.rushHourEveningStart;
  if (cfg.rushHourEveningEnd) process.env.GEO_RUSH_HOUR_EVENING_END = cfg.rushHourEveningEnd;
  if (cfg.lightHourEarlyEnd) process.env.GEO_LIGHT_HOUR_EARLY_END = cfg.lightHourEarlyEnd;
  if (cfg.lightHourLateStart) process.env.GEO_LIGHT_HOUR_LATE_START = cfg.lightHourLateStart;
}

function fmt(t) { return moment.unix(t).tz(TIMEZONE).format("HH:mm"); }

let passed = 0;
let failed = 0;

function assert(ok, msg) {
  if (ok) { passed++; }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

(async () => {
  const dateStr = process.argv[2] || moment().tz(TIMEZONE).add(1, "day").format("YYYY-MM-DD");
  const demoConfig = getConfig();
  applyGeoEnv(demoConfig);

  console.log("══════════════════════════════════════════════");
  console.log("  暫停銷售時段精確度驗證");
  console.log(`  日期: ${dateStr}`);
  console.log("══════════════════════════════════════════════");
  console.log("");

  // 取資料 + 跑排程
  console.log("⏳ 取得 API 資料 + 排程...");
  const { reservations, driverShifts } = await fetchReservationsAndShifts(dateStr);
  console.log(`   預約: ${reservations.length} | 駕駛班表: ${driverShifts.length}`);

  if (reservations.length === 0) {
    console.log("無預約 → 暫停段應全空（全部可售）");
    const result = { debug: {} };
    const pauses = computePausePeriodsForDate(result.debug, driverShifts, dateStr);
    for (const cat of config.CATEGORIES) {
      assert((pauses[cat.key] || []).length === 0, `${cat.label} 無預約時應無暫停段`);
    }
    console.log(`\n通過: ${passed} | 失敗: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
    return;
  }

  const result = await runSchedule(reservations, driverShifts, demoConfig);
  const debug = result.debug || {};

  const dayStart = moment.tz(dateStr, TIMEZONE).startOf("day").unix();
  const dayEnd = dayStart + 23 * 3600 + 59 * 60 + 59; // 23:59:59

  // 建立 vehicleType map
  const vehicleTypeMap = {};
  driverShifts.forEach((ds) => {
    vehicleTypeMap[String(ds.driverId)] = ds.vehicleType || "STANDARD";
  });

  // 計算暫停段
  const pausePeriodsMap = computePausePeriodsForDate(debug, driverShifts, dateStr);

  // ─────────────────────────────────────────
  //  Test A: 分班駕駛是否正確納入
  // ─────────────────────────────────────────
  console.log("\n▶ Test A: 分班駕駛覆蓋驗證");

  const driverShiftCount = {};
  driverShifts.forEach((ds) => {
    const k = String(ds.driverId);
    driverShiftCount[k] = (driverShiftCount[k] || 0) + 1;
  });
  const splitDrivers = Object.entries(driverShiftCount).filter(([, c]) => c > 1);
  console.log(`  分班駕駛: ${splitDrivers.length} 位`);

  for (const [did, count] of splitDrivers) {
    // 確認排程結果中有這位駕駛
    const sched = result.schedule[did] || result.schedule[Number(did)];
    const debugEntry = debug[did] || debug[Number(did)];
    const slots = debugEntry ? debugEntry.insertableSlots || [] : [];

    // 確認他的 insertableSlots 覆蓋了多個班次
    const allWindows = [];
    slots.forEach((s) => s.windows.forEach((w) => allWindows.push(w)));

    // 看班次時間
    const shifts = driverShifts.filter((ds) => String(ds.driverId) === did);
    const shiftRanges = shifts.map((s) => {
      const b = s.shift.shiftBeginTime;
      const e = s.shift.shiftEndTime;
      return {
        begin: dayStart + b.hour * 3600 + (b.minute || 0) * 60,
        end: dayStart + (e.isoWeekday - b.isoWeekday) * 86400 + e.hour * 3600 + (e.minute || 0) * 60,
      };
    });

    // 確認每個有效班次（>5分鐘）至少有一些 insertable window 或被排了行程
    const validShiftRanges = shiftRanges.filter((sr) => sr.end - sr.begin > 5 * 60);
    let coveredShifts = 0;
    for (const sr of validShiftRanges) {
      const hasWindow = allWindows.some(
        (w) => w.startTime < sr.end && w.endTime > sr.begin
      );
      const trips = sched ? (sched.reservations || []) : [];
      const hasTrip = trips.some((t) => {
        const rt = typeof t === "object" ? t.reservationTime : 0;
        return rt >= sr.begin && rt <= sr.end;
      });
      if (hasWindow || hasTrip) coveredShifts++;
    }

    assert(
      coveredShifts === validShiftRanges.length,
      `駕駛 ${did} 有 ${validShiftRanges.length} 個有效班次（>5min），但只有 ${coveredShifts} 個被納入排程`
    );
  }

  // ─────────────────────────────────────────
  //  Test B: 暫停段 = insertableSlots 的精確補集
  // ─────────────────────────────────────────
  console.log("\n▶ Test B: 暫停段 = insertableSlots 補集驗證（分鐘級）");

  for (const cat of config.CATEGORIES) {
    const pausePeriods = pausePeriodsMap[cat.key] || [];

    // 收集該車種所有 insertable windows
    const allAvailableWindows = [];
    Object.entries(debug).forEach(([driverId, dbg]) => {
      const vType = vehicleTypeMap[String(driverId)] || "STANDARD";
      if (vType !== cat.vehicleType) return;
      (dbg.insertableSlots || [])
        .filter((s) => s.tripType === cat.tripType)
        .forEach((s) => s.windows.forEach((w) => {
          allAvailableWindows.push({ start: w.startTime, end: w.endTime });
        }));
    });

    const mergedAvailable = mergeIntervals(allAvailableWindows);

    // 展開成分鐘集合
    const availMinutes = new Set();
    for (const a of mergedAvailable) {
      const s = Math.max(0, Math.floor((a.start - dayStart) / 60));
      const e = Math.min(1440, Math.ceil((a.end - dayStart) / 60));
      for (let m = s; m < e; m++) availMinutes.add(m);
    }

    const pauseMinutes = new Set();
    for (const p of pausePeriods) {
      const s = Math.max(0, Math.floor((p.start - dayStart) / 60));
      const e = Math.min(1440, Math.ceil((p.end - dayStart) / 60));
      for (let m = s; m < e; m++) pauseMinutes.add(m);
    }

    // 驗證：可售 + 暫停 應覆蓋全天 (0~1439)
    let missingMinutes = 0;
    let overlapMinutes = 0;
    for (let m = 0; m < 1440; m++) {
      const inAvail = availMinutes.has(m);
      const inPause = pauseMinutes.has(m);
      if (!inAvail && !inPause) missingMinutes++;
      if (inAvail && inPause) overlapMinutes++;
    }

    // 允許少量 gap（暫停段退讓 1 分鐘邊界造成的緩衝區，每段暫停最多 2 分鐘 gap）
    const maxAllowedGap = pausePeriods.length * 2;
    assert(
      missingMinutes <= maxAllowedGap,
      `${cat.label}: ${missingMinutes} 分鐘既不在可售也不在暫停中（超過允許的 ${maxAllowedGap}）`
    );
    assert(
      overlapMinutes === 0,
      `${cat.label}: ${overlapMinutes} 分鐘同時在可售和暫停中（overlap）`
    );

    console.log(
      `  ${cat.label}: 可售 ${availMinutes.size} min + 暫停 ${pauseMinutes.size} min` +
      ` = ${availMinutes.size + pauseMinutes.size}/1440` +
      ` | overlap=${overlapMinutes} | gap=${missingMinutes}` +
      ` | 暫停段 ${pausePeriods.length} 段`
    );
  }

  // ─────────────────────────────────────────
  //  Test C: 每個暫停時段確實無駕駛可接
  // ─────────────────────────────────────────
  console.log("\n▶ Test C: 暫停段內無駕駛可接驗證");

  for (const cat of config.CATEGORIES) {
    const pausePeriods = pausePeriodsMap[cat.key] || [];

    for (const p of pausePeriods) {
      // 在暫停段中間取一個時間點
      const mid = Math.floor((p.start + p.end) / 2);

      // 檢查該車種所有駕駛在此時間點是否有 insertable window
      let anyDriverHasSlot = false;
      Object.entries(debug).forEach(([driverId, dbg]) => {
        const vType = vehicleTypeMap[String(driverId)] || "STANDARD";
        if (vType !== cat.vehicleType) return;
        (dbg.insertableSlots || [])
          .filter((s) => s.tripType === cat.tripType)
          .forEach((s) => {
            s.windows.forEach((w) => {
              if (mid >= w.startTime && mid < w.endTime) {
                anyDriverHasSlot = true;
              }
            });
          });
      });

      assert(
        !anyDriverHasSlot,
        `${cat.label} 暫停段 ${fmt(p.start)}~${fmt(p.end)} 中間 ${fmt(mid)} 有駕駛可接！`
      );
    }
  }

  // ─────────────────────────────────────────
  //  Test D: 每個可售時段確實有駕駛可接
  // ─────────────────────────────────────────
  console.log("\n▶ Test D: 可售時段內至少一位駕駛可接驗證");

  for (const cat of config.CATEGORIES) {
    const pausePeriods = pausePeriodsMap[cat.key] || [];

    // 算出可售段
    const pauseMinSet = new Set();
    for (const p of pausePeriods) {
      const s = Math.max(0, Math.floor((p.start - dayStart) / 60));
      const e = Math.min(1440, Math.ceil((p.end - dayStart) / 60));
      for (let m = s; m < e; m++) pauseMinSet.add(m);
    }

    // 可售段 = 全天 - 暫停
    const availableMinutes = [];
    for (let m = 0; m < 1440; m++) {
      if (!pauseMinSet.has(m)) availableMinutes.push(m);
    }

    // 在每個可售區段取樣驗證
    if (availableMinutes.length === 0) continue;

    // 取樣：每 30 分鐘取一個點
    let samplesChecked = 0;
    let samplesFailed = 0;
    for (let i = 0; i < availableMinutes.length; i += 30) {
      const m = availableMinutes[i];
      const t = dayStart + m * 60;
      samplesChecked++;

      let anyDriverHasSlot = false;
      Object.entries(debug).forEach(([driverId, dbg]) => {
        const vType = vehicleTypeMap[String(driverId)] || "STANDARD";
        if (vType !== cat.vehicleType) return;
        (dbg.insertableSlots || [])
          .filter((s) => s.tripType === cat.tripType)
          .forEach((s) => {
            s.windows.forEach((w) => {
              if (t >= w.startTime && t < w.endTime) anyDriverHasSlot = true;
            });
          });
      });

      if (!anyDriverHasSlot) samplesFailed++;
    }

    // 允許極少量失敗（暫停段退讓邊界造成的 1-min 緩衝區）
    const maxFail = Math.ceil(samplesChecked * 0.02); // 2% tolerance
    assert(
      samplesFailed <= maxFail,
      `${cat.label}: ${samplesFailed}/${samplesChecked} 個可售取樣點沒有駕駛可接（允許 ${maxFail}）`
    );
    console.log(`  ${cat.label}: ${samplesChecked} 取樣, ${samplesChecked - samplesFailed} OK, ${samplesFailed} 邊界 ✓`);
  }

  // ─────────────────────────────────────────
  //  Test E: 暫停段不重疊、不相鄰
  // ─────────────────────────────────────────
  console.log("\n▶ Test E: 暫停段不重疊、不相鄰驗證");

  for (const cat of config.CATEGORIES) {
    const periods = pausePeriodsMap[cat.key] || [];
    let hasOverlap = false;
    let hasAdjacent = false;

    for (let i = 0; i < periods.length - 1; i++) {
      if (periods[i].end > periods[i + 1].start) hasOverlap = true;
      if (periods[i].end === periods[i + 1].start) hasAdjacent = true;
      // 相鄰判定（≤60秒間隔也算）
      if (periods[i + 1].start - periods[i].end <= 60 && periods[i + 1].start - periods[i].end >= 0) hasAdjacent = true;
    }

    assert(!hasOverlap, `${cat.label}: 暫停段有重疊`);
    assert(!hasAdjacent, `${cat.label}: 暫停段有相鄰（應已合併）`);
  }

  // ─────────────────────────────────────────
  //  Test F: 暫停段在 00:00~23:59 範圍內
  // ─────────────────────────────────────────
  console.log("\n▶ Test F: 暫停段邊界驗證");

  for (const cat of config.CATEGORIES) {
    const periods = pausePeriodsMap[cat.key] || [];
    for (const p of periods) {
      assert(
        p.start >= dayStart && p.end <= dayEnd + 60,
        `${cat.label}: 暫停段 ${fmt(p.start)}~${fmt(p.end)} 超出當日範圍`
      );
    }
  }

  // ─────────────────────────────────────────
  //  結果
  // ─────────────────────────────────────────
  console.log("");
  console.log("══════════════════════════════════════════════");
  console.log(`  通過: ${passed} | 失敗: ${failed}`);
  console.log("══════════════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

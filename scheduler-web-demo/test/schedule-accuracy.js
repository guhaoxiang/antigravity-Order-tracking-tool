"use strict";

/**
 * 排程準確度分析腳本
 *
 * 用真實 API 資料跑排程，再逐一驗證：
 *   1. 每位駕駛的行程是否合理（時間/距離/電量）
 *   2. 未分配訂單是否真的塞不進任何駕駛
 *   3. 是否有更近的駕駛可以接某筆訂單
 *
 * 用法: node test/schedule-accuracy.js [YYYY-MM-DD]
 */

const moment = require("moment-timezone");
const { fetchReservationsAndShifts } = require("../core/zemo-client");
const { getConfig } = require("../core/env-config");
const { runSchedule } = require("../core/scheduler-engine");
const {
  getDistance,
  estimatePointToPointDuration,
  estimateReservationDuration,
  getReservationCategory,
} = require("../zemo-lib/libs/geo");
const Env = require("../zemo-lib/libs/environment");
const TAIPEI = "Asia/Taipei";

// ── 時間工具 ──
function fmt(unix) {
  if (unix == null) return "--:--";
  return moment.unix(unix).tz(TAIPEI).format("HH:mm");
}
function pad(n) {
  return String(n).padStart(2, "0");
}

// ── 套用 demo 設定到 process.env（與 schedule 路由一致）──
function applyConfigToEnv(config) {
  if (config.geoRushHourMinutes != null) process.env.GEO_RUSH_HOUR_MINUTES = String(config.geoRushHourMinutes);
  if (config.geoLightHourMinutes != null) process.env.GEO_LIGHT_HOUR_MINUTES = String(config.geoLightHourMinutes);
  if (config.geoEstimatedSpeedBands != null)
    process.env.GEO_ESTIMATED_SPEED_BANDS =
      typeof config.geoEstimatedSpeedBands === "string"
        ? config.geoEstimatedSpeedBands
        : JSON.stringify(config.geoEstimatedSpeedBands);
  if (config.rushHourMorningStart) process.env.GEO_RUSH_HOUR_MORNING_START = config.rushHourMorningStart;
  if (config.rushHourMorningEnd) process.env.GEO_RUSH_HOUR_MORNING_END = config.rushHourMorningEnd;
  if (config.rushHourEveningStart) process.env.GEO_RUSH_HOUR_EVENING_START = config.rushHourEveningStart;
  if (config.rushHourEveningEnd) process.env.GEO_RUSH_HOUR_EVENING_END = config.rushHourEveningEnd;
  if (config.lightHourEarlyEnd) process.env.GEO_LIGHT_HOUR_EARLY_END = config.lightHourEarlyEnd;
  if (config.lightHourLateStart) process.env.GEO_LIGHT_HOUR_LATE_START = config.lightHourLateStart;
}

// ── 班次時間轉 unix ──
function shiftToUnix(shift, workDayStartUnix) {
  if (!shift || !shift.shiftBeginTime || !shift.shiftEndTime) return null;
  const b = shift.shiftBeginTime;
  const e = shift.shiftEndTime;
  const begin = workDayStartUnix + b.hour * 3600 + (b.minute || 0) * 60;
  const end =
    workDayStartUnix + (e.isoWeekday - b.isoWeekday) * 86400 + e.hour * 3600 + (e.minute || 0) * 60;
  return { begin, end };
}

// ── 判斷駕駛是否能在時間窗內接一筆訂單 ──
function canDriverTakeReservation(driverSchedule, res, shiftInfo, homeGeo, existingTrips) {
  const reasons = [];
  if (!shiftInfo) {
    reasons.push("無班表");
    return { ok: false, reasons };
  }

  // 車種檢查
  if (
    res.requiredVehicleType &&
    res.requiredVehicleType !== "STANDARD" &&
    driverSchedule.vehicleType !== res.requiredVehicleType
  ) {
    reasons.push(`車種不符(需${res.requiredVehicleType})`);
    return { ok: false, reasons };
  }

  // 班表時間檢查
  const resTime = res.reservationTime;
  if (resTime < shiftInfo.begin - Env.firstReservationBufferSeconds) {
    reasons.push(`早於班表(${fmt(shiftInfo.begin)})`);
  }

  // 行程時間估算
  const resDuration = estimateReservationDuration(res);
  const resEnd = resTime + resDuration;
  if (resEnd > shiftInfo.end) {
    reasons.push(`超出班表結束(${fmt(shiftInfo.end)})`);
  }

  // 與既有行程衝突檢查
  const trips = (existingTrips || []).sort((a, b) => a.reservationTime - b.reservationTime);

  // 找可插入的位置（前一筆行程結束到下一筆行程開始的空檔）
  let canFitInGap = false;
  let bestGapInfo = null;

  // 產生所有空檔
  const gaps = [];
  if (trips.length === 0) {
    gaps.push({
      startTime: shiftInfo.begin,
      endTime: shiftInfo.end,
      prevEndGeo: homeGeo,
      prevEndTime: shiftInfo.begin,
      nextStartGeo: null,
      nextStartTime: shiftInfo.end,
    });
  } else {
    // before first
    gaps.push({
      startTime: shiftInfo.begin,
      endTime: trips[0].reservationTime,
      prevEndGeo: homeGeo,
      prevEndTime: shiftInfo.begin,
      nextStartGeo: trips[0].origin.geo,
      nextStartTime: trips[0].reservationTime,
    });
    // between
    for (let i = 0; i < trips.length - 1; i++) {
      const prevEnd = trips[i].reservationTime + estimateReservationDuration(trips[i]);
      gaps.push({
        startTime: prevEnd,
        endTime: trips[i + 1].reservationTime,
        prevEndGeo: trips[i].dest.geo,
        prevEndTime: prevEnd,
        nextStartGeo: trips[i + 1].origin.geo,
        nextStartTime: trips[i + 1].reservationTime,
      });
    }
    // after last
    const lastTrip = trips[trips.length - 1];
    const lastEnd = lastTrip.reservationTime + estimateReservationDuration(lastTrip);
    gaps.push({
      startTime: lastEnd,
      endTime: shiftInfo.end,
      prevEndGeo: lastTrip.dest.geo,
      prevEndTime: lastEnd,
      nextStartGeo: null,
      nextStartTime: shiftInfo.end,
    });
  }

  for (const gap of gaps) {
    // 司機從上一個位置到新訂單起點
    const transitToOrigin = gap.prevEndGeo
      ? estimatePointToPointDuration(gap.prevEndGeo, res.origin.geo, gap.prevEndTime)
      : 0;
    const earliestArrival = gap.prevEndTime + transitToOrigin + Env.betweenReservationBufferSeconds;

    if (earliestArrival > resTime) continue; // 趕不到

    const tripEnd = resTime + resDuration;
    if (tripEnd > gap.endTime) continue; // 超出空檔

    // 若有下一筆，確認趕得上
    if (gap.nextStartGeo && gap.nextStartTime) {
      const transitToNext = estimatePointToPointDuration(res.dest.geo, gap.nextStartGeo, tripEnd);
      const arriveNext = tripEnd + transitToNext + Env.betweenReservationBufferSeconds;
      if (arriveNext > gap.nextStartTime) continue;
    }

    canFitInGap = true;
    bestGapInfo = {
      transitToOriginMin: (transitToOrigin / 60).toFixed(0),
      fromLabel: gap.prevEndGeo ? `(${gap.prevEndGeo.lat.toFixed(3)},${gap.prevEndGeo.lng.toFixed(3)})` : "home",
    };
    break;
  }

  if (!canFitInGap) {
    reasons.push("無可用時間空檔");
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, reasons: [], gapInfo: bestGapInfo };
}

// ── 主程式 ──
(async () => {
  const dateArg = process.argv[2] || moment().tz(TAIPEI).format("YYYY-MM-DD");
  const config = getConfig();
  applyConfigToEnv(config);

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  排程準確度分析");
  console.log(`  日期: ${dateArg}`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");

  // 1. 取得真實資料
  console.log("⏳ 正在取得 API 資料...");
  const { reservations, driverShifts, warning } = await fetchReservationsAndShifts(dateArg);
  if (warning) console.log("⚠ ", warning);
  console.log(`   預約數: ${reservations.length}   駕駛班表數: ${driverShifts.length}`);
  console.log("");

  if (reservations.length === 0) {
    console.log("無預約資料，結束。");
    return;
  }

  // 2. 跑排程
  console.log("⏳ 正在執行排程演算法...");
  const result = await runSchedule(reservations, driverShifts, config);
  const schedule = result.schedule || {};
  const summary = result.summary || {};
  console.log(`   已分配: ${summary.assignedReservations || 0}   未分配: ${summary.unassignedReservations || 0}   總預約: ${summary.totalReservations || 0}`);
  console.log("");

  // 3. 整理資料結構
  const workDayStartUnix = moment.tz(dateArg, TAIPEI).startOf("day").unix();
  const resById = {};
  reservations.forEach((r) => {
    resById[r.id] = r;
    resById[String(r.id)] = r;
  });

  // 建立每位駕駛的排程資訊
  const driverInfoMap = {};
  const allAssignedResIds = new Set();

  for (const ds of driverShifts) {
    const did = String(ds.driverId);
    if (!driverInfoMap[did]) {
      driverInfoMap[did] = {
        driverId: ds.driverId,
        vehicleType: ds.vehicleType || "STANDARD",
        homeGeo: ds.homeLocation ? ds.homeLocation.geo : null,
        homeAddress: ds.homeLocation ? ds.homeLocation.address : "",
        shifts: [],
        assignedReservations: [],
      };
    }
    const shiftUnix = shiftToUnix(ds.shift, workDayStartUnix);
    if (shiftUnix) driverInfoMap[did].shifts.push(shiftUnix);
  }

  Object.keys(schedule).forEach((did) => {
    const s = schedule[did];
    // 如果 schedule 裡有此駕駛但 driverInfoMap 裡沒有，新增之
    if (!driverInfoMap[String(did)]) {
      driverInfoMap[String(did)] = {
        driverId: Number(did),
        vehicleType: "STANDARD",
        homeGeo: null,
        homeAddress: "",
        shifts: [],
        assignedReservations: [],
      };
    }
    const info = driverInfoMap[String(did)];
    const resItems = s.reservations || [];
    resItems.forEach((item) => {
      // item 可能是完整 reservation object（含 id），也可能是純 ID
      const rid = typeof item === "object" && item !== null ? item.id : item;
      const r = resById[rid] || resById[String(rid)] || (typeof item === "object" ? item : null);
      if (r) {
        info.assignedReservations.push(r);
        allAssignedResIds.add(String(r.id || rid));
      }
    });
    info.assignedReservations.sort((a, b) => a.reservationTime - b.reservationTime);
  });

  // 未分配的預約（演算法標記的 + 完全未出現在 schedule 中的）
  const unassigned = reservations.filter((r) => !allAssignedResIds.has(String(r.id)));

  // ─────────────────────────────────────────────
  //  4. 每位駕駛排程摘要
  // ─────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  各駕駛排程摘要");
  console.log("═══════════════════════════════════════════════════════════════");

  const driverIds = Object.keys(driverInfoMap).sort((a, b) => {
    const na = driverInfoMap[a].assignedReservations.length;
    const nb = driverInfoMap[b].assignedReservations.length;
    return nb - na;
  });

  for (const did of driverIds) {
    const info = driverInfoMap[did];
    const trips = info.assignedReservations;
    const shiftStr = info.shifts.map((s) => `${fmt(s.begin)}~${fmt(s.end)}`).join(", ");
    console.log(`\n▶ 駕駛 ${did} | ${info.vehicleType} | 班表: ${shiftStr || "無"} | 行程: ${trips.length} 趟`);

    if (trips.length === 0) {
      console.log("  (無分配行程)");
      continue;
    }

    let prevEndGeo = info.homeGeo;
    let prevEndTime = info.shifts[0] ? info.shifts[0].begin : null;
    let totalTransitKm = 0;
    let totalTripKm = 0;

    for (let i = 0; i < trips.length; i++) {
      const r = trips[i];
      const tripDistKm = getDistance(r.origin.geo, r.dest.geo);
      const tripDurSec = estimateReservationDuration(r);
      const tripEnd = r.reservationTime + tripDurSec;
      totalTripKm += tripDistKm;

      // 空車距離
      let transitKm = 0;
      let transitMin = 0;
      let transitLabel = "";
      if (prevEndGeo && prevEndTime) {
        transitKm = getDistance(prevEndGeo, r.origin.geo);
        transitMin = estimatePointToPointDuration(prevEndGeo, r.origin.geo, prevEndTime) / 60;
        totalTransitKm += transitKm;
      }

      // 與下一趟的間隔
      const nextTrip = trips[i + 1] || null;
      let gapMin = null;
      if (nextTrip) {
        gapMin = ((nextTrip.reservationTime - tripEnd) / 60).toFixed(0);
      }

      const originAddr = (r.origin.address || "").slice(0, 15);
      const destAddr = (r.dest.address || "").slice(0, 15);
      const passengerName = r.passenger ? r.passenger.name || "" : "";

      let line = `  ${fmt(r.reservationTime)} ${originAddr}→${destAddr}`;
      line += ` | ${tripDistKm.toFixed(1)}km ${(tripDurSec / 60).toFixed(0)}min`;
      if (transitKm > 0.5) {
        line += ` | 空車${transitKm.toFixed(1)}km/${transitMin.toFixed(0)}min`;
      }
      if (gapMin !== null) {
        line += ` | 間隔${gapMin}min`;
      }
      if (passengerName) {
        line += ` | ${passengerName}`;
      }

      // 驗證：間隔是否足夠
      if (nextTrip) {
        const transitToNext = estimatePointToPointDuration(r.dest.geo, nextTrip.origin.geo, tripEnd);
        const arriveNext = tripEnd + transitToNext + Env.betweenReservationBufferSeconds;
        if (arriveNext > nextTrip.reservationTime) {
          const overMin = ((arriveNext - nextTrip.reservationTime) / 60).toFixed(0);
          line += ` ⚠️ 趕不上下一趟(差${overMin}min)`;
        }
      }

      console.log(line);
      prevEndGeo = r.dest.geo;
      prevEndTime = tripEnd;
    }

    console.log(`  ── 空車合計: ${totalTransitKm.toFixed(1)} km | 載客合計: ${totalTripKm.toFixed(1)} km`);
  }

  // ─────────────────────────────────────────────
  //  5. 未分配訂單逐筆分析
  // ─────────────────────────────────────────────
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  未分配訂單分析（共 ${unassigned.length} 筆）`);
  console.log("═══════════════════════════════════════════════════════════════");

  if (unassigned.length === 0) {
    console.log("  ✓ 無未分配訂單");
  }

  for (const r of unassigned.sort((a, b) => a.reservationTime - b.reservationTime)) {
    const originAddr = (r.origin.address || "").slice(0, 20);
    const destAddr = (r.dest.address || "").slice(0, 20);
    const reqVehicle = r.requiredVehicleType || "ANY";
    console.log(
      `\n  ✗ #${r.id} ${fmt(r.reservationTime)} ${originAddr}→${destAddr} | ${reqVehicle} | ${r.passenger ? r.passenger.name || "" : ""}`
    );

    // 逐一檢查每位駕駛
    const candidateResults = [];
    for (const did of driverIds) {
      const info = driverInfoMap[did];
      const primaryShift = info.shifts[0] || null;
      const result = canDriverTakeReservation(
        { vehicleType: info.vehicleType },
        r,
        primaryShift,
        info.homeGeo,
        info.assignedReservations
      );
      candidateResults.push({ did, ...result, vehicleType: info.vehicleType });
    }

    const couldTake = candidateResults.filter((c) => c.ok);
    if (couldTake.length === 0) {
      console.log("    → 所有駕駛都無法接單（合理）");
      // 顯示部分拒絕原因
      const topReasons = {};
      candidateResults.forEach((c) => {
        c.reasons.forEach((reason) => {
          topReasons[reason] = (topReasons[reason] || 0) + 1;
        });
      });
      const sorted = Object.entries(topReasons).sort((a, b) => b[1] - a[1]);
      sorted.slice(0, 3).forEach(([reason, count]) => {
        console.log(`      ${reason}: ${count}/${candidateResults.length} 位駕駛`);
      });
    } else {
      console.log(`    → ⚠️ 有 ${couldTake.length} 位駕駛可能可以接:`);
      couldTake.forEach((c) => {
        const info = driverInfoMap[c.did];
        const dist = info.homeGeo
          ? getDistance(info.homeGeo, r.origin.geo).toFixed(1)
          : "?";
        console.log(
          `      駕駛 ${c.did} (${c.vehicleType}, 目前 ${info.assignedReservations.length} 趟, 距離 ${dist}km)`
        );
      });
    }
  }

  // ─────────────────────────────────────────────
  //  6. 跨駕駛最佳性檢查
  // ─────────────────────────────────────────────
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  跨駕駛最佳性檢查（是否有更近的駕駛能接）");
  console.log("═══════════════════════════════════════════════════════════════");

  let betterAlternatives = 0;

  for (const did of driverIds) {
    const info = driverInfoMap[did];
    const trips = info.assignedReservations;

    for (let i = 0; i < trips.length; i++) {
      const r = trips[i];
      // 此趟行程的「實際空車距離」
      let actualPrevGeo;
      if (i === 0) {
        actualPrevGeo = info.homeGeo;
      } else {
        actualPrevGeo = trips[i - 1].dest.geo;
      }
      const actualTransitKm = actualPrevGeo ? getDistance(actualPrevGeo, r.origin.geo) : 999;

      // 檢查其他駕駛是否有更近的選擇
      for (const otherDid of driverIds) {
        if (otherDid === did) continue;
        const otherInfo = driverInfoMap[otherDid];
        const otherTrips = otherInfo.assignedReservations;
        const otherShift = otherInfo.shifts[0];
        if (!otherShift) continue;

        // 車種
        if (
          r.requiredVehicleType &&
          r.requiredVehicleType !== "STANDARD" &&
          otherInfo.vehicleType !== r.requiredVehicleType
        )
          continue;

        // 找出此駕駛在此預約時間前後最近的空檔位置
        const otherPrevTrips = otherTrips.filter(
          (t) => t.reservationTime + estimateReservationDuration(t) <= r.reservationTime
        );
        const otherPrevGeo = otherPrevTrips.length > 0
          ? otherPrevTrips[otherPrevTrips.length - 1].dest.geo
          : otherInfo.homeGeo;

        if (!otherPrevGeo) continue;
        const altTransitKm = getDistance(otherPrevGeo, r.origin.geo);

        // 只報告空車距離差距 > 10km 的情況
        if (altTransitKm < actualTransitKm - 10) {
          // 確認這位駕駛真的能接
          const check = canDriverTakeReservation(
            { vehicleType: otherInfo.vehicleType },
            r,
            otherShift,
            otherInfo.homeGeo,
            otherTrips
          );
          if (check.ok) {
            betterAlternatives++;
            console.log(
              `  ⚠ #${r.id} ${fmt(r.reservationTime)} → 目前指派駕駛${did}(空車${actualTransitKm.toFixed(1)}km),` +
                ` 但駕駛${otherDid}更近(空車${altTransitKm.toFixed(1)}km, 省${(actualTransitKm - altTransitKm).toFixed(1)}km)`
            );
            break; // 只報第一個更好的候選
          }
        }
      }
    }
  }

  if (betterAlternatives === 0) {
    console.log("  ✓ 未發現明顯更佳的跨駕駛替換方案（空車距離差 >10km 且可行）");
  } else {
    console.log(`\n  共 ${betterAlternatives} 筆可能有更近的替換方案`);
  }

  // ─────────────────────────────────────────────
  //  7. 總結
  // ─────────────────────────────────────────────
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  總結");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  日期: ${dateArg}`);
  console.log(`  總預約: ${reservations.length}`);
  console.log(`  已分配: ${reservations.length - unassigned.length}`);
  console.log(`  未分配: ${unassigned.length}`);

  const trueUnassignable = unassigned.filter((r) => {
    return driverIds.every((did) => {
      const info = driverInfoMap[did];
      return !canDriverTakeReservation(
        { vehicleType: info.vehicleType },
        r,
        info.shifts[0],
        info.homeGeo,
        info.assignedReservations
      ).ok;
    });
  });
  const suspiciouslyUnassigned = unassigned.length - trueUnassignable.length;
  console.log(`  確實無法分配: ${trueUnassignable.length}`);
  console.log(`  可能可分配但未分配: ${suspiciouslyUnassigned}`);
  console.log(`  跨駕駛可優化筆數: ${betterAlternatives}`);
})().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

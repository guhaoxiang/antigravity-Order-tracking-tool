/**
 * Debug script: 分析葉僑耘 04/04 為何 22:40 接機無法被分配
 */
const moment = require("moment-timezone");
const { fetchReservationsAndShifts } = require("./core/zemo-client");
const { runSchedule } = require("./core/scheduler-engine");
const { getConfig } = require("./core/env-config");
const {
  getDistance,
  estimatePointToPointDuration,
  estimateReservationDuration,
  getPointToPointDurationBreakdown,
  isAtAirport,
  isAtTpeAirport,
} = require("./zemo-lib/libs/geo");
const { populateInternalReservationTime } = require("./zemo-lib/libs/reservation");
const Env = require("./zemo-lib/libs/environment");

const TZ = "Asia/Taipei";
const fmtTime = (ts) => ts ? moment.unix(ts).tz(TZ).format("HH:mm") : "N/A";
const fmtDateTime = (ts) => ts ? moment.unix(ts).tz(TZ).format("YYYY-MM-DD HH:mm") : "N/A";

async function main() {
  const dateStr = "2026-04-04";
  const targetName = "葉僑耘";

  console.log("══════════════════════════════════════════════");
  console.log(`  Debug: ${targetName} ${dateStr} 排程分析`);
  console.log("══════════════════════════════════════════════\n");

  // 載入設定並套用 geo 環境變數
  const demoConfig = getConfig();
  if (demoConfig.geoRushHourMinutes != null) process.env.GEO_RUSH_HOUR_MINUTES = String(demoConfig.geoRushHourMinutes);
  if (demoConfig.geoLightHourMinutes != null) process.env.GEO_LIGHT_HOUR_MINUTES = String(demoConfig.geoLightHourMinutes);
  if (demoConfig.geoEstimatedSpeedBands != null)
    process.env.GEO_ESTIMATED_SPEED_BANDS = typeof demoConfig.geoEstimatedSpeedBands === "string"
      ? demoConfig.geoEstimatedSpeedBands : JSON.stringify(demoConfig.geoEstimatedSpeedBands);
  if (demoConfig.rushHourMorningStart) process.env.GEO_RUSH_HOUR_MORNING_START = demoConfig.rushHourMorningStart;
  if (demoConfig.rushHourMorningEnd) process.env.GEO_RUSH_HOUR_MORNING_END = demoConfig.rushHourMorningEnd;
  if (demoConfig.rushHourEveningStart) process.env.GEO_RUSH_HOUR_EVENING_START = demoConfig.rushHourEveningStart;
  if (demoConfig.rushHourEveningEnd) process.env.GEO_RUSH_HOUR_EVENING_END = demoConfig.rushHourEveningEnd;
  if (demoConfig.lightHourEarlyEnd) process.env.GEO_LIGHT_HOUR_EARLY_END = demoConfig.lightHourEarlyEnd;
  if (demoConfig.lightHourLateStart) process.env.GEO_LIGHT_HOUR_LATE_START = demoConfig.lightHourLateStart;

  // ── Step 1: 取得資料 ──
  console.log("[1] 取得預約和駕駛資料...");
  const { reservations, driverShifts, driverMeta, warning } =
    await fetchReservationsAndShifts(dateStr);
  if (warning) console.log("  ⚠ Warning:", warning);
  console.log(`  預約數: ${reservations.length}, 駕駛班次數: ${driverShifts.length}\n`);

  // ── Step 2: 找到目標駕駛 ──
  const driver = (driverMeta || []).find((d) => {
    const name = d.username || d.name || "";
    return String(name).includes(targetName);
  });
  if (!driver) {
    console.log("❌ 找不到駕駛:", targetName);
    return;
  }
  const driverId = String(driver.id);
  console.log(`[2] 找到駕駛: id=${driverId}, name=${driver.username || driver.name}, vehicleType=${driver.vehicleType}`);

  // 該駕駛的所有班次
  const shiftsForDriver = driverShifts.filter((s) => String(s.driverId) === driverId);
  const workDayStart = moment.tz(dateStr, TZ).startOf("day").unix();
  console.log(`  班次數: ${shiftsForDriver.length}`);
  shiftsForDriver.forEach((s, i) => {
    const b = s.shift.shiftBeginTime;
    const e = s.shift.shiftEndTime;
    const beginUnix = workDayStart + b.hour * 3600 + (b.minute || 0) * 60;
    const endUnix = workDayStart + (e.isoWeekday - b.isoWeekday) * 86400 + e.hour * 3600 + (e.minute || 0) * 60;
    console.log(`  班次 ${i}: ${fmtTime(beginUnix)} ~ ${fmtTime(endUnix)} (beginUnix=${beginUnix}, endUnix=${endUnix})`);
  });
  console.log("");

  // ── Step 3: 跑排程 ──
  console.log("[3] 執行排程演算法...");
  const result = await runSchedule(reservations, driverShifts, demoConfig);
  console.log(`  已分配: ${result.summary.assignedReservations}, 未分配: ${result.summary.unassignedReservations}\n`);

  // ── Step 4: 查看駕駛排程結果 ──
  const scheduleForDriver = result.schedule && result.schedule[driverId];
  const dbg = result.debug && result.debug[driverId];

  console.log(`[4] ${targetName} 排程結果:`);
  if (scheduleForDriver) {
    const sortedRes = (scheduleForDriver.reservations || [])
      .slice()
      .sort((a, b) => (a.reservationTime || 0) - (b.reservationTime || 0));
    console.log(`  已分配預約: ${sortedRes.length}`);
    sortedRes.forEach((r) => {
      console.log(`    #${r.id} ${fmtTime(r.reservationTime)} ${r.origin?.address || "?"} → ${r.dest?.address || "?"}`);
    });
  } else {
    console.log("  無排程資料");
  }

  if (dbg) {
    console.log(`\n  workHoursLabel: ${dbg.workHoursLabel}`);
    console.log(`  totalDistanceKm: ${dbg.totalDistanceKm?.toFixed(1)}`);
    console.log(`  totalDrivingMinutes: ${dbg.totalDrivingMinutes}`);
    console.log(`  chargingSegments: ${dbg.chargingSegments?.length || 0}`);

    // 最後一個 trip 的電量
    if (dbg.trips && dbg.trips.length > 0) {
      const lastTrip = dbg.trips[dbg.trips.length - 1];
      const lastSeg = lastTrip.segments && lastTrip.segments[lastTrip.segments.length - 1];
      if (lastSeg) {
        console.log(`\n  最後一趟行程:`);
        console.log(`    #${lastTrip.reservationId} ${fmtTime(lastSeg.startTime)} → ${fmtTime(lastSeg.endTime)}`);
        console.log(`    ${lastSeg.fromAddress} → ${lastSeg.toAddress}`);
        console.log(`    距離: ${lastSeg.distanceKm?.toFixed(1)} km, 時間: ${(lastSeg.durationSec / 60).toFixed(1)} min`);
        console.log(`    batteryBeforeKm: ${lastSeg.batteryBeforeKm?.toFixed(1)}, batteryAfterKm: ${lastSeg.batteryAfterKm?.toFixed(1)}`);
      }
    }

    // insertableSlots
    if (dbg.insertableSlots && dbg.insertableSlots.length > 0) {
      console.log(`\n  可塞入時段 (insertableSlots): ${dbg.insertableSlots.length}`);
      dbg.insertableSlots.forEach((s) => {
        const wins = (s.windows || []).map((w) => `${fmtTime(w.startTime)}~${fmtTime(w.endTime)}`).join(", ");
        console.log(`    ${s.tripType} (${s.gapKind}): ${wins}`);
      });
    }
  }

  // ── Step 5: 查看未分配的 22:40 接機 ──
  console.log(`\n[5] 未分配預約 (22:00~23:00 時段):`);
  const unassigned = result.unassignedReservations || [];
  const lateUnassigned = unassigned.filter((r) => {
    const h = moment.unix(r.reservationTime).tz(TZ).hour();
    return h >= 22;
  });

  if (lateUnassigned.length === 0) {
    console.log("  無 22:00 後的未分配預約");
  }

  lateUnassigned.forEach((r) => {
    console.log(`\n  #${r.id} ${fmtDateTime(r.reservationTime)}`);
    console.log(`    ${r.origin?.address || "?"} → ${r.dest?.address || "?"}`);
    console.log(`    requiredVehicleType: ${r.requiredVehicleType || "null (any)"}`);
    console.log(`    origin at airport: ${r.origin?.geo ? isAtAirport(r.origin.geo.lat, r.origin.geo.lng) : "N/A"}`);

    // 手動執行 constraint check
    populateInternalReservationTime(r);
    console.log(`    reservationTime: ${fmtTime(r.reservationTime)} (${r.reservationTime})`);
    console.log(`    internalReservationTime: ${fmtTime(r.internalReservationTime)} (${r.internalReservationTime})`);

    const resDuration = estimateReservationDuration(r);
    const estEndTime = r.internalReservationTime + resDuration;
    console.log(`    estimateReservationDuration: ${(resDuration / 60).toFixed(1)} min`);
    console.log(`    estimatedEndTime: ${fmtTime(estEndTime)}`);

    // 用葉僑耘的最後位置模擬 eligibility check
    if (dbg && dbg.trips && dbg.trips.length > 0) {
      const lastTrip = dbg.trips[dbg.trips.length - 1];
      const lastSeg = lastTrip.segments && lastTrip.segments[lastTrip.segments.length - 1];
      if (lastSeg && lastTrip.reservation) {
        const driverLastGeo = lastTrip.reservation.dest?.geo;
        const driverLastTime = lastSeg.endTime;
        const driverBatteryAfter = lastSeg.batteryAfterKm;

        console.log(`\n    ── 模擬 ${targetName} eligibility check ──`);
        console.log(`    駕駛最後位置: ${lastTrip.reservation.dest?.address} (${fmtTime(driverLastTime)})`);
        console.log(`    駕駛剩餘電量: ${driverBatteryAfter?.toFixed(1)} km`);

        // 班表檢查
        shiftsForDriver.forEach((s, i) => {
          const b = s.shift.shiftBeginTime;
          const e = s.shift.shiftEndTime;
          const beginUnix = workDayStart + b.hour * 3600 + (b.minute || 0) * 60;
          const endUnix = workDayStart + (e.isoWeekday - b.isoWeekday) * 86400 + e.hour * 3600 + (e.minute || 0) * 60;

          const shiftCheckFail = r.reservationTime < beginUnix || r.reservationTime > endUnix;
          console.log(`\n    [班表 ${i}] ${fmtTime(beginUnix)}~${fmtTime(endUnix)}`);
          console.log(`      reservationTime(${fmtTime(r.reservationTime)}) > shiftEnd(${fmtTime(endUnix)})? ${r.reservationTime > endUnix} → ${shiftCheckFail ? "❌ FAIL" : "✅ PASS"}`);

          // gap-filling 的邊界檢查
          console.log(`      internalReservationTime(${fmtTime(r.internalReservationTime)}) > shiftEnd(${fmtTime(endUnix)})? ${r.internalReservationTime > endUnix} → ${r.internalReservationTime > endUnix ? "❌ gap-fill FAIL" : "✅ gap-fill PASS"}`);
        });

        // transit time check
        if (driverLastGeo && r.origin?.geo) {
          const dist = getDistance(driverLastGeo, r.origin.geo);
          const transitSec = estimatePointToPointDuration(driverLastGeo, r.origin.geo, driverLastTime);
          const buffer = Env.betweenReservationBufferSeconds;
          const arrivalTime = driverLastTime + transitSec + buffer;

          console.log(`\n    [移動時間]`);
          console.log(`      距離: ${dist.toFixed(2)} km`);
          console.log(`      transitTime: ${(transitSec / 60).toFixed(1)} min`);
          console.log(`      buffer: ${buffer / 60} min`);
          console.log(`      arrivalTime: ${fmtTime(arrivalTime)} (${arrivalTime})`);
          console.log(`      arrivalTime(${fmtTime(arrivalTime)}) <= internalReservationTime(${fmtTime(r.internalReservationTime)})? ${arrivalTime <= r.internalReservationTime} → ${arrivalTime <= r.internalReservationTime ? "✅ PASS" : "❌ FAIL"}`);

          // breakdown
          try {
            const bd = getPointToPointDurationBreakdown(driverLastGeo, r.origin.geo, driverLastTime);
            if (bd) {
              console.log(`      breakdown: dist=${bd.distanceKm?.toFixed(2)}km, speed=${bd.estimatedSpeedKmh}km/h, base=${(bd.baseSec/60).toFixed(1)}min, extra=${(bd.extraSec/60).toFixed(1)}min (${bd.extraReason}), total=${(bd.totalSec/60).toFixed(1)}min`);
            }
          } catch {}

          // 電量檢查
          const distToRes = dist;
          const resDist = getDistance(r.origin.geo, r.dest.geo);
          const totalDist = distToRes + resDist;
          console.log(`\n    [電量]`);
          console.log(`      移動到起點: ${distToRes.toFixed(2)} km`);
          console.log(`      行程距離: ${resDist.toFixed(2)} km`);
          console.log(`      total: ${totalDist.toFixed(2)} km`);
          console.log(`      剩餘電量: ${driverBatteryAfter?.toFixed(1)} km`);
          console.log(`      totalDist(${totalDist.toFixed(1)}) <= battery(${driverBatteryAfter?.toFixed(1)})? ${totalDist <= driverBatteryAfter} → ${totalDist <= driverBatteryAfter ? "✅ PASS" : "❌ FAIL"}`);
        }
      }
    }
  });

  console.log("\n══════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});

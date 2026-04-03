"use strict";

const moment = require("moment-timezone");
const { fetchReservationsAndShifts } = require("../../scheduler-web-demo/core/zemo-client");
const { getConfig } = require("../../scheduler-web-demo/core/env-config");
const { runSchedule } = require("../../scheduler-web-demo/core/scheduler-engine");
const { getDistance, estimatePointToPointDuration } = require("../../scheduler-web-demo/zemo-lib/libs/geo");
const Env = require("../../scheduler-web-demo/zemo-lib/libs/environment");

const cfg = getConfig();
if (cfg.geoRushHourMinutes != null) process.env.GEO_RUSH_HOUR_MINUTES = String(cfg.geoRushHourMinutes);
if (cfg.geoLightHourMinutes != null) process.env.GEO_LIGHT_HOUR_MINUTES = String(cfg.geoLightHourMinutes);
if (cfg.geoEstimatedSpeedBands != null)
  process.env.GEO_ESTIMATED_SPEED_BANDS = typeof cfg.geoEstimatedSpeedBands === "string"
    ? cfg.geoEstimatedSpeedBands : JSON.stringify(cfg.geoEstimatedSpeedBands);

function fmt(t) { return moment.unix(t).tz("Asia/Taipei").format("HH:mm"); }

(async () => {
  const { reservations, driverShifts, driverMeta } = await fetchReservationsAndShifts("2026-04-01");
  const result = await runSchedule(reservations, driverShifts, cfg);

  const did = "1467";
  const dbg = result.debug[did] || result.debug[Number(did)];
  const meta = (driverMeta || []).find((d) => d.id === 1467);
  const timeline = dbg.timelineItems || [];
  const slots = dbg.insertableSlots || [];

  console.log("==================================================");
  console.log("  朱柏年 (1467) 04/01 排程詳細分析");
  console.log("==================================================");
  console.log("");
  console.log("班表:", dbg.workHoursLabel);
  console.log("車種:", meta ? meta.vehicleType : "?");
  console.log("");

  console.log("【完整時間軸】");
  timeline.forEach((item) => {
    if (item.type === "transit") {
      console.log(
        "  [移動]", fmt(item.startTime) + "~" + fmt(item.endTime),
        "|", (item.fromAddress || "").slice(0, 15), "→", (item.toAddress || "").slice(0, 15),
        "|", (item.distanceKm || 0).toFixed(1) + "km", Math.round(item.durationSec / 60) + "min",
        "| 電量:", (item.batteryBeforeKm != null ? item.batteryBeforeKm.toFixed(0) : "?") + "→" +
          (item.batteryAfterKm != null ? item.batteryAfterKm.toFixed(0) : "?") + "km"
      );
    } else if (item.type === "trip") {
      const r = item.reservation || {};
      const seg = item.segments && item.segments[0];
      console.log(
        "  [行程]", fmt(seg ? seg.startTime : r.reservationTime) + "~" + fmt(seg ? seg.endTime : 0),
        "|", (r.origin && r.origin.address || "").slice(0, 20), "→", (r.dest && r.dest.address || "").slice(0, 20),
        "|", (item.distanceKm || 0).toFixed(1) + "km",
        "| 電量after:", (item.batteryAfterKm != null ? item.batteryAfterKm.toFixed(0) : "?") + "km"
      );
    } else if (item.type === "charging") {
      console.log(
        "  [充電]", fmt(item.startTime) + "~" + fmt(item.endTime),
        "|", Math.round((item.endTime - item.startTime) / 60) + "min"
      );
    }
  });

  console.log("");
  console.log("【可塞入假行程】");
  if (slots.length === 0) {
    console.log("  (無)");
  } else {
    slots.forEach((s) => {
      s.windows.forEach((w) => {
        console.log("  " + s.tripType, fmt(w.startTime) + "~" + fmt(w.endTime),
          "| 電量餘裕:", (w.minBatteryMarginKmUntilNextCharge != null ? w.minBatteryMarginKmUntilNextCharge.toFixed(1) : "?") + "km");
      });
    });
  }

  // 手動分析
  const tripItems = timeline.filter((it) => it.type === "trip");
  tripItems.sort((a, b) => {
    const sa = a.segments && a.segments[0] ? a.segments[0].startTime : a.startTime;
    const sb = b.segments && b.segments[0] ? b.segments[0].startTime : b.startTime;
    return sa - sb;
  });

  if (tripItems.length >= 2) {
    const trip1 = tripItems[0];
    const trip2 = tripItems[1];
    const seg1 = trip1.segments && trip1.segments[0];
    const seg2 = trip2.segments && trip2.segments[0];
    const trip1End = seg1 ? seg1.endTime : 0;
    const trip2Start = seg2 ? seg2.startTime : 0;
    const trip1DestGeo = trip1.reservation.dest.geo;
    const trip2OriginGeo = trip2.reservation.origin.geo;

    console.log("");
    console.log("==================================================");
    console.log("  手動模擬：能不能在兩趟之間塞送機？");
    console.log("==================================================");
    console.log("");
    console.log("第一趟結束:", fmt(trip1End), "| 地點:", (trip1.reservation.dest.address || "").slice(0, 25));
    console.log("第二趟開始:", fmt(trip2Start), "| 地點:", (trip2.reservation.origin.address || "").slice(0, 25));
    console.log("空檔:", Math.round((trip2Start - trip1End) / 60), "分鐘");
    console.log("電量 trip1 後:", (trip1.batteryAfterKm || 0).toFixed(0), "km");

    const TAIPEI_STATION = { lat: 25.047712, lng: 121.516178 };
    const AIRPORT = { lat: 25.08046397145192, lng: 121.23114560388235 };

    // 送機模擬
    const dist_to_station = getDistance(trip1DestGeo, TAIPEI_STATION);
    const transit_to_station = estimatePointToPointDuration(trip1DestGeo, TAIPEI_STATION, trip1End);
    const earliest_dropoff = trip1End + transit_to_station + Env.betweenReservationBufferSeconds;
    const dropoff_dur = estimatePointToPointDuration(TAIPEI_STATION, AIRPORT, earliest_dropoff);
    const dropoff_end = earliest_dropoff + dropoff_dur;
    const transit_airport_to_trip2 = estimatePointToPointDuration(AIRPORT, trip2OriginGeo, dropoff_end);
    const arrive_trip2 = dropoff_end + transit_airport_to_trip2 + Env.betweenReservationBufferSeconds;

    console.log("");
    console.log("--- 送機模擬 ---");
    console.log("1. trip1 終點 → 台北車站:", dist_to_station.toFixed(1) + "km,", Math.round(transit_to_station / 60) + "min");
    console.log("2. 最早可出發送機:", fmt(earliest_dropoff), "(+ 5min buffer)");
    console.log("3. 台北車站 → 機場:", Math.round(dropoff_dur / 60) + "min");
    console.log("4. 送機結束:", fmt(dropoff_end));
    console.log("5. 機場 → 第二趟起點:", Math.round(transit_airport_to_trip2 / 60) + "min (+ 5min buffer)");
    console.log("6. 預計抵達第二趟:", fmt(arrive_trip2));
    console.log("7. 第二趟開始:", fmt(trip2Start));
    console.log("8. 來得及?", arrive_trip2 <= trip2Start ? "YES" : "NO (差" + Math.round((arrive_trip2 - trip2Start) / 60) + "min)");

    // 電量
    const batteryAfterTrip1 = trip1.batteryAfterKm || 0;
    const dist_station_airport = getDistance(TAIPEI_STATION, AIRPORT);
    const dist_airport_trip2 = getDistance(AIRPORT, trip2OriginGeo);
    const consumption = dist_to_station + dist_station_airport + dist_airport_trip2;

    // 後續行程消耗
    let subsequentKm = 0;
    for (let i = 1; i < tripItems.length; i++) {
      const r = tripItems[i].reservation;
      if (r && r.origin && r.dest) subsequentKm += getDistance(r.origin.geo, r.dest.geo);
    }

    console.log("");
    console.log("--- 電量檢查 ---");
    console.log("trip1 後電量:", batteryAfterTrip1.toFixed(0) + "km");
    console.log("送機消耗: 到車站(" + dist_to_station.toFixed(1) + ") + 車站到機場(" + dist_station_airport.toFixed(1) + ") + 機場到trip2(" + dist_airport_trip2.toFixed(1) + ") = " + consumption.toFixed(1) + "km");
    console.log("後續行程消耗:", subsequentKm.toFixed(1) + "km");
    console.log("總消耗:", (consumption + subsequentKm).toFixed(1) + "km");
    console.log("電量餘裕:", (batteryAfterTrip1 - consumption - subsequentKm).toFixed(1) + "km");
    console.log("電量夠?", (batteryAfterTrip1 - consumption - subsequentKm) >= 0 ? "YES" : "NO");

    // 接機模擬
    console.log("");
    console.log("--- 接機模擬 ---");
    const dist_to_airport = getDistance(trip1DestGeo, AIRPORT);
    const transit_to_airport = estimatePointToPointDuration(trip1DestGeo, AIRPORT, trip1End);
    const arrive_airport = trip1End + transit_to_airport;
    console.log("1. trip1 終點 → 機場:", dist_to_airport.toFixed(1) + "km,", Math.round(transit_to_airport / 60) + "min");
    console.log("2. 抵達機場:", fmt(arrive_airport));

    const PICKUP_BUFFER = 50 * 60;
    // reservationTime = arrive_airport - PICKUP_BUFFER (最早)
    // rideStart = reservationTime + PICKUP_BUFFER = arrive_airport
    const pickup_ride_start = arrive_airport;
    const pickup_dur = estimatePointToPointDuration(AIRPORT, TAIPEI_STATION, pickup_ride_start);
    const pickup_end = pickup_ride_start + pickup_dur;
    const transit_station_to_trip2 = estimatePointToPointDuration(TAIPEI_STATION, trip2OriginGeo, pickup_end);
    const arrive_trip2_pickup = pickup_end + transit_station_to_trip2 + Env.betweenReservationBufferSeconds;

    console.log("3. 乘客上車:", fmt(pickup_ride_start), "(到達機場後)");
    console.log("4. 機場 → 台北車站:", Math.round(pickup_dur / 60) + "min");
    console.log("5. 接機結束:", fmt(pickup_end));
    console.log("6. 台北車站 → 第二趟起點:", Math.round(transit_station_to_trip2 / 60) + "min (+ 5min buffer)");
    console.log("7. 預計抵達第二趟:", fmt(arrive_trip2_pickup));
    console.log("8. 第二趟開始:", fmt(trip2Start));
    console.log("9. 來得及?", arrive_trip2_pickup <= trip2Start ? "YES" : "NO (差" + Math.round((arrive_trip2_pickup - trip2Start) / 60) + "min)");
  }
})();

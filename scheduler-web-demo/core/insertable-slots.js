const {
  getDistance,
  estimatePointToPointDuration: _rawEstimate,
  estimateReservationDuration,
  getReservationCategory,
} = require("../zemo-lib/libs/geo");
const Env = require("../zemo-lib/libs/environment");

const estimatePointToPointDuration = _rawEstimate;

/**
 * 為固定的 from/to 路線建立快速查表函式。
 * 在每個時段邊界預算一次行駛時間，掃描時只做簡單整數比較。
 *
 * @param {Object} from - { lat, lng }
 * @param {Object} to   - { lat, lng }
 * @returns {Function} (referenceTimeUnix) => durationSec
 */
function createFastDurationLookup(from, to) {
  // 收集所有時段邊界（分鐘），去重排序
  const boundaryMin = new Set([0, 1440]);
  [
    Env.geoRushHourMorningStartMin,
    Env.geoRushHourMorningEndMin,
    Env.geoRushHourEveningStartMin,
    Env.geoRushHourEveningEndMin,
    Env.geoLightHourEarlyEndMin,
    Env.geoLightHourLateStartMin,
  ].forEach((m) => { if (m > 0 && m < 1440) boundaryMin.add(m); });
  // 加上 +1 分鐘的邊界（isSameOrBefore vs isBefore 精確切換點）
  [...boundaryMin].forEach((m) => { if (m + 1 < 1440) boundaryMin.add(m + 1); });
  const sorted = [...boundaryMin].sort((a, b) => a - b);

  // 用一個非假日週三作為 sample（2026-04-01 Wed 00:00 +08:00 = 1774972800）
  const sampleDayStart = 1774972800;

  // 對每個區間，取中點預算行駛時間
  const bands = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const startSec = sorted[i] * 60;
    const endSec = sorted[i + 1] * 60;
    const midMin = Math.floor((sorted[i] + sorted[i + 1]) / 2);
    const duration = _rawEstimate(from, to, sampleDayStart + midMin * 60);
    bands.push({ startSec, endSec, duration });
  }

  return function fastDuration(referenceTimeUnix) {
    const secOfDay = ((referenceTimeUnix + 8 * 3600) % 86400 + 86400) % 86400;
    for (const band of bands) {
      if (secOfDay >= band.startSec && secOfDay < band.endSec) return band.duration;
    }
    return bands[bands.length - 1].duration;
  };
}

const DUMMY_TRIPS = [
  {
    tripType: "dropoff",
    name: "送機（台北車站→桃園機場）",
    originLabel: "台北車站",
    originGeo: { lat: 25.047712, lng: 121.516178 },
    destLabel: "桃園機場",
    destGeo: { lat: 25.08046397145192, lng: 121.23114560388235 },
  },
  {
    tripType: "pickup",
    name: "接機（桃園機場→台北車站）",
    originLabel: "桃園機場",
    originGeo: { lat: 25.08046397145192, lng: 121.23114560388235 },
    destLabel: "台北車站",
    destGeo: { lat: 25.047712, lng: 121.516178 },
    pickupBufferSec: 50 * 60,
    arrivalDeadlineBufferSec: 40 * 60,
  },
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function floorToStep(sec, stepSec) {
  if (!sec || !stepSec) return sec;
  return Math.floor(sec / stepSec) * stepSec;
}

function ceilToStep(sec, stepSec) {
  if (!sec || !stepSec) return sec;
  return Math.ceil(sec / stepSec) * stepSec;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  const as = aStart || 0;
  const ae = aEnd || 0;
  const bs = bStart || 0;
  const be = bEnd || 0;
  return as < be && bs < ae;
}

function getNearestPrevTrip(busy, gapStartTime) {
  for (let i = busy.length - 1; i >= 0; i--) {
    const it = busy[i];
    if (!it || it.type !== "trip") continue;
    if (typeof it._busyEnd !== "number") continue;
    if (it._busyEnd <= gapStartTime) return it;
  }
  return null;
}

function isPickupReservation(reservation) {
  if (!reservation || !reservation.origin || !reservation.dest) return false;
  try {
    const category = getReservationCategory(reservation);
    return category && category.purpose === "AIRPORT_ARRIVAL";
  } catch {
    return false;
  }
}

function computeInsertableSlots({
  driverId,
  timelineItems,
  homeGeo,
  shiftBeginUnix,
  shiftEndUnix,
  options,
  debugLog,
}) {
  const insertableSlots = [];
  const timelineSorted = (timelineItems || []).slice().filter(Boolean).sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const busyRaw = timelineSorted
    .filter((it) => it.type === "trip" || it.type === "transit")
    .map((it) => {
      if (it.type === "transit") {
        return {
          ...it,
          _busyStart: typeof it.startTime === "number" ? it.startTime : null,
          _busyEnd: typeof it.endTime === "number" ? it.endTime : null,
        };
      }
      const seg = it.segments && it.segments[0] ? it.segments[0] : null;
      const tripStart =
        seg && typeof seg.startTime === "number"
          ? seg.startTime
          : (it.reservation && typeof it.reservation.reservationTime === "number" ? it.reservation.reservationTime : null);
      const tripEnd =
        seg && typeof seg.endTime === "number"
          ? seg.endTime
          : (
              tripStart != null &&
              it.reservation &&
              it.reservation.origin &&
              it.reservation.origin.geo &&
              it.reservation.dest &&
              it.reservation.dest.geo
            )
            ? tripStart + estimateReservationDuration(it.reservation)
            : null;
      return {
        ...it,
        _busyStart: tripStart,
        _busyEnd: tripEnd,
      };
    })
    .filter((it) => typeof it._busyStart === "number" && typeof it._busyEnd === "number" && it._busyEnd > it._busyStart)
    .sort((a, b) => a._busyStart - b._busyStart);

  // Drop transits whose timeframe overlaps a trip. Such transits are
  // pre-pickup positioning moves (e.g. 充電地點 → 機場 before pickup); they start
  // AFTER the trip's reservationTime and create phantom gaps when sorted by _busyStart.
  // The trip's own busy window already represents the driver's unavailability.
  const _tripsForOverlap = busyRaw.filter((it) => it.type === "trip");
  const busy = busyRaw.filter((it) => {
    if (it.type !== "transit") return true;
    return !_tripsForOverlap.some(
      (tr) => Math.max(it._busyStart, tr._busyStart) < Math.min(it._busyEnd, tr._busyEnd)
    );
  });
  const charging = timelineSorted.filter((it) => it.type === "charging");

  debugLog("run1", "H1", "insertable-slots.js:init", "driver timeline baseline", {
    driverId,
    timelineCount: timelineSorted.length,
    busyCount: busy.length,
    chargingCount: charging.length,
    firstBusyStart: busy[0] ? busy[0]._busyStart : null,
    lastBusyEnd: busy.length ? busy[busy.length - 1]._busyEnd : null,
  });

  const initialBatteryKm =
    options && typeof options.defaultRangeKm === "number" ? options.defaultRangeKm : Env.defaultRangeKm;

  function geoOfBusyStart(it) {
    if (!it) return null;
    if (it.type === "trip" && it.reservation && it.reservation.origin && it.reservation.origin.geo) return it.reservation.origin.geo;
    if (it.type === "transit" && it.fromGeo) return it.fromGeo;
    return null;
  }

  function geoOfBusyEnd(it) {
    if (!it) return null;
    if (it.type === "trip" && it.reservation && it.reservation.dest && it.reservation.dest.geo) return it.reservation.dest.geo;
    if (it.type === "transit" && it.toGeo) return it.toGeo;
    return null;
  }

  function batteryAfterBusy(it) {
    if (!it) return null;
    if (it.type === "trip" && typeof it.batteryAfterKm === "number") return it.batteryAfterKm;
    if (it.type === "transit" && typeof it.batteryAfterKm === "number") return it.batteryAfterKm;
    return null;
  }

  const gaps = [];
  if (busy.length === 0) {
    if (shiftBeginUnix != null && shiftEndUnix != null) {
      gaps.push({
        kind: "entire_shift",
        startTime: shiftBeginUnix - Env.firstReservationBufferSeconds,
        endTime: shiftEndUnix + 3 * 3600,
        prevBusy: null,
        nextBusy: null,
      });
    }
  } else {
    if (shiftBeginUnix != null) {
      gaps.push({
        kind: "before_first",
        startTime: shiftBeginUnix - Env.firstReservationBufferSeconds,
        endTime: busy[0]._busyStart,
        prevBusy: null,
        nextBusy: busy[0],
      });
    }
    for (let i = 0; i < busy.length - 1; i++) {
      let gapEnd = busy[i + 1]._busyStart;
      let nextBusy = busy[i + 1];

      // 如果 nextBusy 是充電後的附屬 transit，且這個 gap 中有充電事件，
      // 則把 gap 延伸到 transit 之後的下一個 trip（充電被取代時 transit 也不存在）
      if (nextBusy.type === "transit" && charging.length > 0) {
        const gapStart = busy[i]._busyEnd;
        const hasChargingInGap = charging.some((c) => overlaps(c.startTime, c.endTime, gapStart, gapEnd));
        if (hasChargingInGap) {
          // 找 transit 之後的下一個 busy item
          const afterTransit = busy[i + 2] || null;
          if (afterTransit) {
            gapEnd = afterTransit._busyStart;
            nextBusy = afterTransit;
          }
        }
      }

      gaps.push({
        kind: "between",
        startTime: busy[i]._busyEnd,
        endTime: gapEnd,
        prevBusy: busy[i],
        nextBusy: nextBusy,
      });
    }
    if (shiftEndUnix != null) {
      // after_last gap 延伸到 shiftEnd + 3 小時，讓 reservationTime 在班表內的行程即使結束超過下班也可行
      gaps.push({
        kind: "after_last",
        startTime: busy[busy.length - 1]._busyEnd,
        endTime: shiftEndUnix + 3 * 3600,
        prevBusy: busy[busy.length - 1],
        nextBusy: null,
      });
    }
  }

  const stepSec = 60;
  gaps
    .filter((g) => typeof g.startTime === "number" && typeof g.endTime === "number" && g.endTime > g.startTime + Env.betweenReservationBufferSeconds)
    .forEach((gap) => {
      const prevEndGeo = gap.prevBusy ? geoOfBusyEnd(gap.prevBusy) : homeGeo;
      const nextStartGeo = gap.nextBusy ? geoOfBusyStart(gap.nextBusy) : null;
      const nextStartTime = gap.nextBusy ? gap.nextBusy._busyStart : null;
      if (!prevEndGeo || !prevEndGeo.lat || !prevEndGeo.lng) return;

      const prevTrip = getNearestPrevTrip(busy, gap.startTime);
      const prevTripReservationTime = prevTrip && prevTrip.reservation ? prevTrip.reservation.reservationTime : null;
      const prevTripIsPickup = prevTrip && prevTrip.reservation ? isPickupReservation(prevTrip.reservation) : false;

      const startBatteryKm =
        (gap.prevBusy && batteryAfterBusy(gap.prevBusy) != null)
          ? batteryAfterBusy(gap.prevBusy)
          : initialBatteryKm;

      const chargingInGap = charging.filter((c) => overlaps(c.startTime, c.endTime, gap.startTime, gap.endTime));
      const replacesCharging = chargingInGap.length > 0;
      debugLog("run1", "H2", "insertable-slots.js:gap", "gap candidate", {
        driverId,
        gapKind: gap.kind,
        gapStart: gap.startTime,
        gapEnd: gap.endTime,
        hasPrevBusy: !!gap.prevBusy,
        hasNextBusy: !!gap.nextBusy,
        replacesCharging,
        chargingInGapCount: chargingInGap.length,
        prevTripIsPickup,
      });

      const nextCharge = charging
        .filter((c) => !overlaps(c.startTime, c.endTime, gap.startTime, gap.endTime))
        .find((c) => (c.startTime || 0) >= (gap.endTime || 0));
      const nextChargeStart = nextCharge ? nextCharge.startTime : null;

      DUMMY_TRIPS.forEach((tripConfig) => {
        const distPrevToOrigin = getDistance(prevEndGeo, tripConfig.originGeo);
        const distDummyTrip = getDistance(tripConfig.originGeo, tripConfig.destGeo);
        const distToNextPickup = nextStartGeo ? getDistance(tripConfig.destGeo, nextStartGeo) : 0;

        let subsequentKm = 0;
        if (nextStartTime != null) {
          for (const it of busy) {
            if (!it || typeof it._busyStart !== "number") continue;
            if (it._busyStart < nextStartTime) continue;
            if (nextChargeStart != null && it._busyStart >= nextChargeStart) break;
            if (typeof it.distanceKm === "number") {
              subsequentKm += it.distanceKm;
            } else if (it.type === "trip" && it.reservation && it.reservation.origin && it.reservation.dest) {
              subsequentKm += getDistance(it.reservation.origin.geo, it.reservation.dest.geo);
            }
          }
        }

        const totalConsumptionKm = distPrevToOrigin + distDummyTrip + distToNextPickup + subsequentKm;

        // 電量預檢：考慮假行程結束後的部分充電機會
        // 若空檔中有充電排程，估算「最早出發假行程」後剩餘的可充電時間
        let maxPartialChargeKm = 0;
        if (replacesCharging && startBatteryKm != null) {
          // 粗估：假行程最快結束時間（用 gap 起點出發）
          const roughTransitSec = estimatePointToPointDuration(prevEndGeo, tripConfig.originGeo, gap.startTime);
          const roughTripSec = estimatePointToPointDuration(tripConfig.originGeo, tripConfig.destGeo, gap.startTime + (roughTransitSec || 0));
          const roughDummyEndTime = gap.startTime + (roughTransitSec || 0) + Env.betweenReservationBufferSeconds + (roughTripSec || 0);
          const remainingGapSec = Math.max(0, gap.endTime - roughDummyEndTime);
          if (remainingGapSec >= Env.minimumIdleTimeToChargeSeconds) {
            maxPartialChargeKm = Math.max(0, (remainingGapSec - Env.estimatedTimeToFindChargingStationSeconds) / 60);
            const maxRange = (options && typeof options.defaultRangeKm === "number") ? options.defaultRangeKm : Env.defaultRangeKm;
            maxPartialChargeKm = Math.min(maxPartialChargeKm, maxRange - (startBatteryKm - distPrevToOrigin - distDummyTrip));
            maxPartialChargeKm = Math.max(0, maxPartialChargeKm);
          }
        }

        const effectiveBatteryKm = (startBatteryKm != null) ? startBatteryKm + maxPartialChargeKm : null;
        const minBatteryMarginKmUntilNextCharge = effectiveBatteryKm != null ? effectiveBatteryKm - totalConsumptionKm : null;
        if (minBatteryMarginKmUntilNextCharge != null && minBatteryMarginKmUntilNextCharge < 0) {
          debugLog("run1", "H3", "insertable-slots.js:batteryReject", "gap rejected by battery", {
            driverId,
            gapKind: gap.kind,
            tripType: tripConfig.tripType,
            startBatteryKm,
            totalConsumptionKm,
            maxPartialChargeKm,
            minBatteryMarginKmUntilNextCharge,
          });
          return;
        }

        // 若駕駛已在 dummy trip 起點附近（< 1km，例如已在機場），transit 視為 0
        const distPrevToOriginRaw = getDistance(prevEndGeo, tripConfig.originGeo);
        const transitPrevToOriginSec = distPrevToOriginRaw < 1
          ? 0
          : estimatePointToPointDuration(prevEndGeo, tripConfig.originGeo, gap.startTime);
        const isPickupTrip = tripConfig.tripType === "pickup";
        const pickupBufferSecForScan = isPickupTrip ? (tripConfig.pickupBufferSec || 0) : 0;
        const baseEarliestStart = isPickupTrip
          ? (gap.startTime - pickupBufferSecForScan)
          : (
              gap.startTime +
              (typeof transitPrevToOriginSec === "number" ? transitPrevToOriginSec : 0) +
              Env.betweenReservationBufferSeconds
            );

        const scanStart = ceilToStep(
          Math.max(
            baseEarliestStart,
            (isPickupTrip ? Number.NEGATIVE_INFINITY : gap.startTime),
            (shiftBeginUnix != null ? shiftBeginUnix : Number.NEGATIVE_INFINITY)
          ),
          stepSec
        );
        const scanEnd = floorToStep(
          Math.min(
            (isPickupTrip ? (gap.endTime - pickupBufferSecForScan) : gap.endTime),
            // reservationTime 必須在班表時間內，但行程結束可超過
            (shiftEndUnix != null ? shiftEndUnix : Number.POSITIVE_INFINITY)
          ),
          stepSec
        );
        if (!(scanEnd > scanStart)) return;

        // 為掃描迴圈建立快速查表（避免每分鐘都呼叫 moment-timezone）
        const fastTripDuration = createFastDurationLookup(tripConfig.originGeo, tripConfig.destGeo);
        const fastTransitToNext = (nextStartGeo)
          ? createFastDurationLookup(tripConfig.destGeo, nextStartGeo)
          : null;

        function canStartAt(t) {
          const isPickup = tripConfig.tripType === "pickup";
          const reservationTime = t;
          const pickupBufferSec = isPickup ? (tripConfig.pickupBufferSec || 0) : 0;
          const arrivalDeadlineBufferSec = isPickup ? (tripConfig.arrivalDeadlineBufferSec || 0) : 0;
          const arrivalAtAirport =
            gap.startTime + (typeof transitPrevToOriginSec === "number" ? Math.max(0, transitPrevToOriginSec) : 0);

          // 前一趟若為接機，後續可塞假行程（送機/接機）都需至少間隔 30 分鐘
          if (prevTripIsPickup && typeof prevTripReservationTime === "number" && reservationTime < prevTripReservationTime + 30 * 60) {
            return false;
          }

          if (isPickup) {
            if (arrivalAtAirport > reservationTime + arrivalDeadlineBufferSec) return false;
          }

          const rideStart = reservationTime + pickupBufferSec;
          if (isPickup && rideStart < gap.startTime) return false;
          if (isPickup && arrivalAtAirport > rideStart) return false;

          const tripSec = fastTripDuration(rideStart);
          const durSec = typeof tripSec === "number" && tripSec > 0 ? tripSec : 0;
          const endAt = rideStart + durSec;

          if (endAt > gap.endTime) return false;
          if (shiftBeginUnix != null && reservationTime < shiftBeginUnix) return false;

          if (nextStartGeo && nextStartTime != null) {
            const transitToNextSec = fastTransitToNext(endAt);
            const arriveNext =
              endAt +
              (typeof transitToNextSec === "number" ? transitToNextSec : 0) +
              Env.betweenReservationBufferSeconds;
            if (arriveNext > nextStartTime) return false;
          }

          // 電量檢查（含部分充電）：假行程結束後，剩餘空檔能充多少電？
          if (startBatteryKm != null) {
            const dummyConsumptionKm = distPrevToOrigin + distDummyTrip;
            const batteryAfterDummy = startBatteryKm - dummyConsumptionKm;

            let partialChargeKm = 0;
            if (replacesCharging) {
              const remainingSec = Math.max(0, gap.endTime - endAt);
              if (remainingSec >= Env.minimumIdleTimeToChargeSeconds) {
                partialChargeKm = Math.max(0, (remainingSec - Env.estimatedTimeToFindChargingStationSeconds) / 60);
                const maxRange = (options && typeof options.defaultRangeKm === "number") ? options.defaultRangeKm : Env.defaultRangeKm;
                partialChargeKm = Math.min(partialChargeKm, Math.max(0, maxRange - batteryAfterDummy));
              }
            }

            const effectiveBattery = batteryAfterDummy + partialChargeKm;
            const remainingConsumption = distToNextPickup + subsequentKm;
            if (effectiveBattery < remainingConsumption) return false;
          }

          return true;
        }

        const feasibleTimes = [];
        for (let t = scanStart; t <= scanEnd; t += stepSec) {
          if (canStartAt(t)) feasibleTimes.push(t);
        }

        const feasibleSet = new Set(feasibleTimes);
        const patchedTimes = [];
        for (let t = scanStart; t <= scanEnd; t += stepSec) {
          if (feasibleSet.has(t)) {
            patchedTimes.push(t);
            continue;
          }
          const prevOk = feasibleSet.has(t - stepSec);
          const nextOk = feasibleSet.has(t + stepSec);
          if (prevOk && nextOk) patchedTimes.push(t);
        }
        patchedTimes.sort((a, b) => a - b);

        debugLog("run1", "H4", "insertable-slots.js:scan", "time-window scan result", {
          driverId,
          gapKind: gap.kind,
          tripType: tripConfig.tripType,
          earliestStart: baseEarliestStart,
          scanStart,
          scanEnd,
          feasibleCount: feasibleTimes.length,
          patchedFeasibleCount: patchedTimes.length,
          nextStartTime: nextStartTime != null ? nextStartTime : null,
        });

        if (patchedTimes.length === 0) return;

        const windows = [];
        let wStart = patchedTimes[0];
        let prev = patchedTimes[0];
        for (let i = 1; i < patchedTimes.length; i++) {
          const curr = patchedTimes[i];
          if (curr === prev + stepSec) {
            prev = curr;
            continue;
          }
          windows.push({ startTime: wStart, endTime: prev });
          wStart = curr;
          prev = curr;
        }
        windows.push({ startTime: wStart, endTime: prev });

        const enrichedWindows = windows
          .map((w) => {
            const mid = w.startTime + Math.floor((w.endTime - w.startTime) / 2 / stepSec) * stepSec;
            const isPickup = tripConfig.tripType === "pickup";
            const pickupBufferSec = isPickup ? (tripConfig.pickupBufferSec || 0) : 0;
            const arrivalDeadlineBufferSec = isPickup ? (tripConfig.arrivalDeadlineBufferSec || 0) : 0;
            const normalizedStart = isPickup ? w.startTime : clamp(w.startTime, gap.startTime, gap.endTime);
            const normalizedEnd = isPickup ? w.endTime : clamp(w.endTime, gap.startTime, gap.endTime);
            return {
              startTime: normalizedStart,
              endTime: normalizedEnd,
              suggestedStartTime: mid,
              minBatteryMarginKmUntilNextCharge:
                typeof minBatteryMarginKmUntilNextCharge === "number" ? minBatteryMarginKmUntilNextCharge : null,
              replacesCharging,
              reservationTimeStart: normalizedStart,
              reservationTimeEnd: normalizedEnd,
              passengerPickupTimeStart: normalizedStart + pickupBufferSec,
              passengerPickupTimeEnd: normalizedEnd + pickupBufferSec,
              driverArrivalDeadlineStart: normalizedStart + arrivalDeadlineBufferSec,
              driverArrivalDeadlineEnd: normalizedEnd + arrivalDeadlineBufferSec,
            };
          })
          .filter((w) => w.endTime > w.startTime);

        if (enrichedWindows.length === 0) return;
        const overlapWithBusyCount = enrichedWindows.reduce((sum, w) => {
          const overlapCount = busy.filter((b) => overlaps(w.startTime, w.endTime, b._busyStart, b._busyEnd)).length;
          return sum + overlapCount;
        }, 0);

        debugLog("run1", "H5", "insertable-slots.js:push", "slot windows generated", {
          driverId,
          gapKind: gap.kind,
          tripType: tripConfig.tripType,
          windows: enrichedWindows.map((w) => ({
            start: w.startTime,
            end: w.endTime,
            suggested: w.suggestedStartTime,
          })),
          overlapWithBusyCount,
        });
        insertableSlots.push({
          driverId,
          tripType: tripConfig.tripType,
          tripName: tripConfig.name,
          originLabel: tripConfig.originLabel,
          destLabel: tripConfig.destLabel,
          gapKind: gap.kind,
          windows: enrichedWindows,
        });
      });
    });

  return insertableSlots;
}

module.exports = {
  DUMMY_TRIPS,
  computeInsertableSlots,
};

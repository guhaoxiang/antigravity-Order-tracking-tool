const { getConfig } = require("./env-config");

// 使用 zemo-lib/（從 zemo-api 複製的本地副本，可獨立維護）
const { proximitySchedulingAlgorithm } = require("../zemo-lib/libs/proximity");
const { vehicleRoutingScheduler } = require("../zemo-lib/libs/vehicle-routing");
const { getDistance, estimatePointToPointDuration, estimateReservationDuration, getReservationDistance, getPointToPointDurationBreakdown } = require("../zemo-lib/libs/geo");
const Env = require("../zemo-lib/libs/environment");
const { TAIPEI_TIMEZONE } = require("../zemo-lib/constants/constants");
const momentTZ = require("moment-timezone");
const { computeInsertableSlots } = require("./insertable-slots");

/**
 * 根據目前 demo 的 env 設定，覆寫 zemo-api constants 中的企業／司機優先度常數。
 * 僅修改 Node.js 記憶體中的 module export，不會寫回檔案，也不會影響正式環境。
 */
function applyPriorityAndDriverConstantsFromConfig(env) {
  try {
    const enterpriseConsts = require("../zemo-lib/constants/enterprise");
    const driversConsts = require("../zemo-lib/constants/drivers");

    // 企業優先度：高／低優先企業集合
    if (enterpriseConsts && enterpriseConsts.HIGH_PRIORITY_ENTERPRISES && typeof env.highPriorityEnterpriseIdsCsv === "string" && env.highPriorityEnterpriseIdsCsv.trim() !== "") {
      const ids = String(env.highPriorityEnterpriseIdsCsv)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
      if (ids.length > 0) {
        enterpriseConsts.HIGH_PRIORITY_ENTERPRISES.clear();
        ids.forEach((id) => enterpriseConsts.HIGH_PRIORITY_ENTERPRISES.add(id));
      }
    }

    if (enterpriseConsts && enterpriseConsts.LOW_PRIORITY_ENTERPRISES && typeof env.lowPriorityEnterpriseIdsCsv === "string" && env.lowPriorityEnterpriseIdsCsv.trim() !== "") {
      const ids = String(env.lowPriorityEnterpriseIdsCsv)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
      if (ids.length > 0) {
        enterpriseConsts.LOW_PRIORITY_ENTERPRISES.clear();
        ids.forEach((id) => enterpriseConsts.LOW_PRIORITY_ENTERPRISES.add(id));
      }
    }

    // 司機優先層級：Relief / Secondary 司機 ID 陣列
    if (driversConsts && Array.isArray(driversConsts.RELIEF_DRIVER_IDS) && typeof env.reliefDriverIdsCsv === "string" && env.reliefDriverIdsCsv.trim() !== "") {
      const ids = String(env.reliefDriverIdsCsv)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
      if (ids.length > 0) {
        driversConsts.RELIEF_DRIVER_IDS.length = 0;
        ids.forEach((id) => driversConsts.RELIEF_DRIVER_IDS.push(id));
      }
    }

    if (driversConsts && Array.isArray(driversConsts.SECONDARY_DRIVER_IDS) && typeof env.secondaryDriverIdsCsv === "string" && env.secondaryDriverIdsCsv.trim() !== "") {
      const ids = String(env.secondaryDriverIdsCsv)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
      if (ids.length > 0) {
        driversConsts.SECONDARY_DRIVER_IDS.length = 0;
        ids.forEach((id) => driversConsts.SECONDARY_DRIVER_IDS.push(id));
      }
    }
  } catch {
    // 若 constants 模組載入或覆寫失敗，視為 demo 模式下靜默忽略，不影響主流程。
  }
}

/**
 * 產生每位司機的簡易運算過程（行程段落、時間與電量估算）
 * 完全重用主演算法輸出的 tasks（reservation + charging），不再在這裡重算續航。
 */
function buildDriverDebug(schedule, driverShifts, reservations, options) {
  const debugByDriver = {};
  const shiftsByDriver = {};
  (driverShifts || []).forEach((s) => {
    if (!shiftsByDriver[s.driverId]) shiftsByDriver[s.driverId] = [];
    shiftsByDriver[s.driverId].push(s);
  });

  const workDayStartUnix =
    reservations && reservations.length > 0 && reservations[0] && reservations[0].reservationTime
      ? momentTZ.unix(reservations[0].reservationTime).tz(TAIPEI_TIMEZONE).startOf("day").unix()
      : momentTZ().tz(TAIPEI_TIMEZONE).startOf("day").unix();

  const resById = {};
  (reservations || []).forEach((r) => {
    resById[r.id] = r;
    resById[String(r.id)] = r;
    if (typeof r.id === "string" && !Number.isNaN(Number(r.id))) resById[Number(r.id)] = r;
  });

  function createTransitTimelineItem({
    fromAddress,
    fromGeo,
    toAddress,
    toGeo,
    startTime,
    endTime,
    distanceKm,
    durationSec,
    batteryBeforeKm,
    batteryAfterKm,
    breakdown,
  }) {
    const item = {
      type: "transit",
      fromAddress: fromAddress || "",
      toAddress: toAddress || "",
      fromGeo: fromGeo || null,
      toGeo: toGeo || null,
      startTime: startTime || 0,
      endTime: endTime || 0,
      distanceKm: typeof distanceKm === "number" ? distanceKm : 0,
      durationSec: typeof durationSec === "number" ? durationSec : 0,
      batteryBeforeKm: batteryBeforeKm != null ? batteryBeforeKm : null,
      batteryAfterKm: batteryAfterKm != null ? batteryAfterKm : null,
    };

    if (breakdown && typeof breakdown === "object") {
      if (typeof breakdown.estimatedSpeedKmh === "number") {
        item.estimatedSpeedKmh = breakdown.estimatedSpeedKmh;
      }
      if (typeof breakdown.hourFactorMinutes === "number") {
        item.hourFactorMinutes = breakdown.hourFactorMinutes;
      }
      if (typeof breakdown.regionMinutes === "number") {
        item.regionMinutes = breakdown.regionMinutes;
      }
      if (typeof breakdown.baseSec === "number") {
        item.baseDurationSec = breakdown.baseSec;
      }
      if (typeof breakdown.extraSec === "number") {
        item.extraDurationSec = breakdown.extraSec;
      }
      if (breakdown.extraReason) {
        item.extraReason = breakdown.extraReason;
      }
    }

    return item;
  }

  function getShiftBoundaryUnix(firstShiftForDay) {
    if (!firstShiftForDay || !firstShiftForDay.shift || !firstShiftForDay.shift.shiftBeginTime || !firstShiftForDay.shift.shiftEndTime) {
      return null;
    }

    const b = firstShiftForDay.shift.shiftBeginTime;
    const e = firstShiftForDay.shift.shiftEndTime;
    const shiftBeginUnix = workDayStartUnix + b.hour * 3600 + b.minute * 60;
    const shiftEndUnix =
      workDayStartUnix +
      (e.isoWeekday - b.isoWeekday) * 86400 +
      e.hour * 3600 +
      e.minute * 60;

    return { shiftBeginUnix, shiftEndUnix };
  }

  function debugLog(runId, hypothesisId, location, message, data) {
    fetch("http://127.0.0.1:7267/ingest/68544e9d-8df1-4b8b-9a69-584ce7119933", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "b432da",
      },
      body: JSON.stringify({
        sessionId: "b432da",
        runId,
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }

  Object.keys(schedule || {}).forEach((driverId) => {
    const key = String(driverId);
    const s = schedule[driverId] || {};
    const reservationsForDriver = s.reservations || [];
    const tasksForDriver = (s.tasks || []).slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    const driverShiftsForDay = shiftsByDriver[driverId] || shiftsByDriver[key] || [];
    const firstShift = driverShiftsForDay[0] || {};
    const shiftBoundary = getShiftBoundaryUnix(firstShift);
    const shiftBeginUnix = shiftBoundary ? shiftBoundary.shiftBeginUnix : null;
    const shiftEndUnix = shiftBoundary ? shiftBoundary.shiftEndUnix : null;
    const homeGeo = firstShift && firstShift.homeLocation && firstShift.homeLocation.geo ? firstShift.homeLocation.geo : null;

    // 當日實際可上班時段（若有班表，支援多班次顯示）
    let workHoursLabel = null;
    if (driverShiftsForDay.length > 0) {
      const pad2 = (n) => String(n ?? 0).padStart(2, "0");
      const labels = driverShiftsForDay
        .filter((ds) => ds.shift && ds.shift.shiftBeginTime && ds.shift.shiftEndTime)
        .map((ds) => {
          const b = ds.shift.shiftBeginTime;
          const e = ds.shift.shiftEndTime;
          return `${pad2(b.hour)}:${pad2(b.minute)} ~ ${pad2(e.hour)}:${pad2(e.minute)}`;
        })
        .filter((lbl, i, arr) => {
          // 過濾掉 ≤5 分鐘的極短班次（如 15:59~16:00）
          const ds = driverShiftsForDay[i];
          if (!ds || !ds.shift) return false;
          const b = ds.shift.shiftBeginTime;
          const e = ds.shift.shiftEndTime;
          const durMin = (e.hour - b.hour) * 60 + (e.minute || 0) - (b.minute || 0);
          return durMin > 5;
        });
      workHoursLabel = labels.length > 0 ? labels.join("、") : null;
    }

    const trips = [];
    const timelineItems = [];
    const chargingSegments = [];
    let totalDistanceKm = 0;
    let totalDrivingMinutes = 0;

    let lastLocationGeo = null;
    let lastLocationLabel = null;
    let lastEndTime = null;
    let lastBatteryAfterKmForTransit = null;
    let lastChargingTransitBreakdown = null;

    for (let taskIndex = 0; taskIndex < tasksForDriver.length; taskIndex++) {
      const task = tasksForDriver[taskIndex];
      if (!task) continue;

      if (task.type === "charging") {
        const start = task.startTime || 0;
        const durationSec = task.duration || 0;
        const end = start + durationSec;
        const rangeBeforeKm = task.rangeBeforeCharge != null ? task.rangeBeforeCharge : null;
        const rangeAfterKm =
          task.rangeAfterCharge != null
            ? task.rangeAfterCharge
            : (task.remainingRangeKm != null ? task.remainingRangeKm : null);

        chargingSegments.push({
          type: "charging",
          startTime: start,
          endTime: end,
          durationSec,
          rangeBeforeKm,
          rangeAfterKm,
        });

        const chargingDebug = task.chargingDebug || {};
        const idleTimeSec = chargingDebug.idleTimeSeconds != null ? chargingDebug.idleTimeSeconds : durationSec;
        const findStationSec = chargingDebug.findStationSeconds != null ? chargingDebug.findStationSeconds : 0;
        const effectiveChargingSec =
          chargingDebug.effectiveChargingSeconds != null
            ? chargingDebug.effectiveChargingSeconds
            : Math.max(0, idleTimeSec - findStationSec);

        const arrivalTimeAtCharging =
          chargingDebug.arrivalTimeAtCharging != null ? chargingDebug.arrivalTimeAtCharging : start;
        const startFindStationTime = arrivalTimeAtCharging;
        const endFindStationTime = arrivalTimeAtCharging + findStationSec;
        const mustFinishChargingTime = chargingDebug.mustFinishChargingTime || null;

        // 若 chargingDebug 沒有帶 nextReservationTime / transitToNextPickupSeconds，從下一筆預約任務反推
        let nextReservationTime = chargingDebug.nextReservationTime != null ? chargingDebug.nextReservationTime : null;
        let transitToNextPickupSeconds =
          chargingDebug.transitToNextPickupSeconds != null ? chargingDebug.transitToNextPickupSeconds : null;
        if ((nextReservationTime == null || transitToNextPickupSeconds == null) && mustFinishChargingTime != null) {
          const nextResTask = tasksForDriver.slice(taskIndex + 1).find((t) => t && t.type === "reservation" && t.reservation);
          if (nextResTask && nextResTask.reservation) {
            const r = nextResTask.reservation;
            const fullRes = resById[r.id] || resById[String(r.id)] || r;
            const nextTime =
              (fullRes && (fullRes.internalReservationTime != null ? fullRes.internalReservationTime : fullRes.reservationTime)) ||
              (r.internalReservationTime != null ? r.internalReservationTime : r.reservationTime);
            if (nextTime != null) {
              if (nextReservationTime == null) nextReservationTime = nextTime;
              if (transitToNextPickupSeconds == null)
                transitToNextPickupSeconds = Math.max(0, Math.round(nextTime - mustFinishChargingTime));
            }
          }
        }

        const transitToNextPickupMin =
          transitToNextPickupSeconds != null ? Math.round(transitToNextPickupSeconds / 60) : null;

        const b = chargingDebug.transitToNextPickupBreakdown;
        const transitBreakdown =
          b && typeof b.distanceKm === "number"
            ? {
                distanceKm: b.distanceKm,
                estimatedSpeedKmh: b.estimatedSpeedKmh,
                baseSec: b.baseSec,
                baseMin: Math.round((b.baseSec || 0) / 60),
                extraSec: b.extraSec,
                extraMin: Math.round((b.extraSec || 0) / 60),
                extraReason: b.extraReason || "無",
                hourFactorMinutes: b.hourFactorMinutes,
                regionMinutes: b.regionMinutes,
                totalSec: b.totalSec,
                totalMin: Math.round((b.totalSec || 0) / 60),
              }
            : null;

        timelineItems.push({
          type: "charging",
          startTime: start,
          endTime: end,
          durationSec,
          rangeBeforeKm,
          rangeAfterKm,
          startTimeReason: "主演算法 charging 任務",
          durationReason: `停留約 ${Math.round(durationSec / 60)} 分鐘（由主演算法決定）`,
          rangeCalculation:
            rangeBeforeKm != null && rangeAfterKm != null
              ? `原 ${rangeBeforeKm.toFixed(1)} km → 剩餘 ${rangeAfterKm.toFixed(1)} km（+${(rangeAfterKm - rangeBeforeKm).toFixed(1)} km）`
              : null,
          chargingCalculation: {
            idleTimeSec,
            idleTimeMin: Math.floor(idleTimeSec / 60),
            findStationSec,
            findStationMin: Math.floor(findStationSec / 60),
            effectiveChargingSec,
            effectiveChargingMin: Math.floor(effectiveChargingSec / 60),
            startFindStationTime,
            endFindStationTime,
            mustFinishChargingTime,
            rangeBeforeKm,
            rangeAfterComputed: rangeAfterKm,
            rangeGainKm:
              chargingDebug.rangeGainKm != null && !Number.isNaN(chargingDebug.rangeGainKm)
                ? chargingDebug.rangeGainKm
                : rangeBeforeKm != null && rangeAfterKm != null
                ? rangeAfterKm - rangeBeforeKm
                : null,
            rangeCapKm: chargingDebug.rangeCapKm != null ? chargingDebug.rangeCapKm : chargingDebug.defaultRangeKm,
            defaultRangeKm: chargingDebug.defaultRangeKm != null ? chargingDebug.defaultRangeKm : null,
            transitToNextPickupSeconds,
            transitToNextPickupMin,
            transitBreakdown,
            nextReservationTime,
          },
        });

        lastLocationGeo = null;
        lastLocationLabel = "充電地點";
        lastEndTime = end;
        lastBatteryAfterKmForTransit = rangeAfterKm;
        lastChargingTransitBreakdown = transitBreakdown;

        continue;
      }

      if (task.type === "reservation" && task.reservation) {
        const r = task.reservation;
        const fullRes =
          resById[r.id] ||
          resById[String(r.id)] ||
          r;

        // 優先使用主演算法提供的起訖時間與距離，若缺失則回退到 geo 模組估算
        const startTime = fullRes.reservationTime || task.startTime || 0;
        let endTime = task.estimatedEndTime || startTime;

        let distanceTripKm = typeof task.distanceKm === "number" ? task.distanceKm : 0;
        if (!distanceTripKm && fullRes.origin && fullRes.dest) {
          // 若主演算法未提供 distanceKm，使用 getReservationDistance 或 getDistance 作為基礎距離
          distanceTripKm = typeof getReservationDistance === "function"
            ? getReservationDistance(fullRes)
            : getDistance(fullRes.origin.geo, fullRes.dest.geo);
        }

        const transitKm = typeof task.transitDistanceKm === "number" ? task.transitDistanceKm : 0;
        const totalKm = typeof task.totalDistanceKm === "number" ? task.totalDistanceKm : distanceTripKm + transitKm;

        let durationSec = endTime && startTime ? endTime - startTime : 0;

        if (fullRes.origin && fullRes.origin.geo && lastEndTime != null) {
          let transitDistanceKm = null;
          let transitDurationSec = null;
          let transitBreakdownForItem = null;
          const fromAddress =
            lastLocationLabel ||
            (fullRes.origin && (fullRes.origin.address || fullRes.origin.name)) ||
            "上一行程終點";
          const toAddress =
            (fullRes.origin && (fullRes.origin.address || fullRes.origin.name)) ||
            "下一趟行程起點";

          if (lastChargingTransitBreakdown && typeof lastChargingTransitBreakdown.distanceKm === "number") {
            transitDistanceKm = lastChargingTransitBreakdown.distanceKm;
            transitDurationSec =
              typeof lastChargingTransitBreakdown.totalSec === "number"
                ? lastChargingTransitBreakdown.totalSec
                : null;
            transitBreakdownForItem = lastChargingTransitBreakdown;
          } else if (lastLocationGeo) {
            try {
              const bd = getPointToPointDurationBreakdown(
                lastLocationGeo,
                fullRes.origin.geo,
                lastEndTime || startTime
              );
              if (bd && typeof bd.totalSec === "number" && bd.totalSec > 0) {
                transitBreakdownForItem = bd;
                transitDurationSec = bd.totalSec;
                if (typeof bd.distanceKm === "number") {
                  transitDistanceKm = bd.distanceKm;
                }
              }
            } catch {
              transitBreakdownForItem = null;
            }

            if (transitDistanceKm == null) {
              transitDistanceKm = getDistance(lastLocationGeo, fullRes.origin.geo);
            }
            if (transitDurationSec == null && transitDistanceKm != null) {
              const est = estimatePointToPointDuration(lastLocationGeo, fullRes.origin.geo, lastEndTime || startTime);
              if (typeof est === "number" && est > 0) {
                transitDurationSec = est;
              }
            }
          }

          if (transitDistanceKm != null && transitDurationSec != null) {
            const batteryBeforeKm = lastBatteryAfterKmForTransit != null ? lastBatteryAfterKmForTransit : null;
            const batteryAfterKmTransit =
              batteryBeforeKm != null
                ? Math.max(0, batteryBeforeKm - transitDistanceKm)
                : null;

            const transitItem = createTransitTimelineItem({
              fromAddress,
              fromGeo: lastLocationGeo || null,
              toAddress,
              toGeo: fullRes.origin.geo || null,
              startTime: lastEndTime || startTime,
              endTime: (lastEndTime || startTime) + transitDurationSec,
              distanceKm: transitDistanceKm,
              durationSec: transitDurationSec,
              batteryBeforeKm,
              batteryAfterKm: batteryAfterKmTransit,
              breakdown: transitBreakdownForItem,
            });

            timelineItems.push(transitItem);

            lastBatteryAfterKmForTransit = batteryAfterKmTransit;
          }
        }

        lastChargingTransitBreakdown = null;

        // 取得純移動時間與 geo breakdown
        let breakdown = null;
        let moveDurationSec = 0;
        if (fullRes.origin && fullRes.origin.geo && fullRes.dest && fullRes.dest.geo && startTime) {
          try {
            breakdown = getPointToPointDurationBreakdown(
              fullRes.origin.geo,
              fullRes.dest.geo,
              startTime
            );
            if (breakdown && typeof breakdown.totalSec === "number" && breakdown.totalSec > 0) {
              moveDurationSec = breakdown.totalSec;
            }
          } catch {
            breakdown = null;
          }
        }
        if (!moveDurationSec && fullRes.origin && fullRes.origin.geo && fullRes.dest && fullRes.dest.geo) {
          const estMove = estimatePointToPointDuration(
            fullRes.origin.geo,
            fullRes.dest.geo,
            startTime
          );
          if (typeof estMove === "number" && estMove > 0) {
            moveDurationSec = estMove;
          }
        }

        // 若主演算法未提供有效 duration（或為 0），改用 geo 模組或 estimateReservationDuration 重新估算時間
        if (!durationSec) {
          if (moveDurationSec > 0) {
            durationSec = moveDurationSec;
            endTime = startTime + durationSec;
          }
          try {
            const estTotal = estimateReservationDuration(fullRes);
            if (typeof estTotal === "number" && estTotal > durationSec) {
              durationSec = estTotal;
              endTime = startTime + durationSec;
            }
            if (typeof estTotal === "number" && moveDurationSec > 0 && estTotal > moveDurationSec) {
              fullRes._airportWaitSeconds = estTotal - moveDurationSec;
            }
          } catch {
            // ignore
          }
        } else {
          // 若已有主演算法提供的 duration，但我們有 geo 的純移動時間與 estimateReservationDuration，可拆出等待秒數
          try {
            const estTotal = estimateReservationDuration(fullRes);
            if (typeof estTotal === "number" && moveDurationSec > 0 && estTotal > moveDurationSec) {
              // estTotal - moveDurationSec 即為機場等待乘客出關的秒數（或類似緩衝）
              // 先保留在局部變數，稍後寫入 segment
              // 注意：不覆寫 durationSec，避免改變主演算法的 estimatedEndTime
              fullRes._airportWaitSeconds = estTotal - moveDurationSec;
            }
          } catch {
            // ignore
          }
        }

        // 若前面沒成功取得 breakdown，再嘗試一次（為顯示分段與加成）
        if (!breakdown && fullRes.origin && fullRes.origin.geo && fullRes.dest && fullRes.dest.geo && startTime) {
          try {
            breakdown = getPointToPointDurationBreakdown(
              fullRes.origin.geo,
              fullRes.dest.geo,
              startTime
            );
          } catch {
            breakdown = null;
          }
        }

        const batteryAfterKm =
          typeof task.remainingRangeKm === "number" ? task.remainingRangeKm : null;
        const batteryBeforeKm =
          batteryAfterKm != null && totalKm
            ? batteryAfterKm + totalKm
            : null;

        totalDistanceKm += totalKm;
        totalDrivingMinutes += durationSec / 60;

        const segment = {
          type: "trip",
          fromAddress:
            (fullRes.origin && (fullRes.origin.address || fullRes.origin.name)) ||
            "起點",
          toAddress:
            (fullRes.dest && (fullRes.dest.address || fullRes.dest.name)) ||
            "終點",
          distanceKm: totalKm,
          durationSec,
          startTime,
          endTime,
          batteryAfterKm,
          batteryBeforeKm,
          airportWaitSeconds: typeof fullRes._airportWaitSeconds === "number" ? fullRes._airportWaitSeconds : 0,
        };
        if (breakdown) {
          segment.estimatedSpeedKmh = breakdown.estimatedSpeedKmh;
          segment.hourFactorMinutes = breakdown.hourFactorMinutes;
          segment.regionMinutes = breakdown.regionMinutes;
          segment.extraReason = breakdown.extraReason;
          segment.extraDurationSec = breakdown.extraSec;
          segment.baseDurationSec = breakdown.baseSec;
        }

        const tripEntry = {
          reservationId: fullRes.id,
          reservation: fullRes,
          segments: [segment],
        };

        trips.push(tripEntry);
        timelineItems.push({
          type: "trip",
          reservation: fullRes,
          segments: [segment],
          batteryAfterKm,
        });

        lastLocationGeo = fullRes.dest && fullRes.dest.geo ? fullRes.dest.geo : null;
        lastLocationLabel =
          (fullRes.dest && (fullRes.dest.address || fullRes.dest.name)) ||
          (fullRes.origin && (fullRes.origin.address || fullRes.origin.name)) ||
          null;
        lastEndTime = endTime;
        lastBatteryAfterKmForTransit = batteryAfterKm;
      }
    }

    // 若主演算法尚未提供 tasks（或格式異常），但 schedule 中已經有 reservations，
    // 為了避免像「陳品彥」這類駕駛出現「預約數 > 0 卻完全沒有行程明細與續航」的情況，
    // 這裡使用 reservations 做一層簡易 fallback，至少產生基本的 trip segment 與距離／時間資訊。
    if (tasksForDriver.length === 0 && reservationsForDriver.length > 0 && trips.length === 0 && timelineItems.length === 0) {
      let cumulativeDistanceKm = 0;

      reservationsForDriver
        .filter((r) => r && r.reservationTime != null && r.origin && r.dest)
        .forEach((r) => {
          const distanceTripKm = getReservationDistance
            ? getReservationDistance(r)
            : getDistance(r.origin.geo, r.dest.geo);
          let moveDurationSec = 0;
          let breakdown = null;
          try {
            breakdown = getPointToPointDurationBreakdown(r.origin.geo, r.dest.geo, r.reservationTime);
            if (breakdown && typeof breakdown.totalSec === "number" && breakdown.totalSec > 0) {
              moveDurationSec = breakdown.totalSec;
            }
          } catch {
            breakdown = null;
          }
          if (!moveDurationSec) {
            const estMove = estimatePointToPointDuration(r.origin.geo, r.dest.geo, r.reservationTime);
            if (typeof estMove === "number" && estMove > 0) {
              moveDurationSec = estMove;
            }
          }

          let totalDurationSec = moveDurationSec;
          let airportWaitSeconds = 0;
          if (typeof estimateReservationDuration === "function") {
            try {
              const estTotal = estimateReservationDuration(r);
              if (typeof estTotal === "number" && estTotal > moveDurationSec) {
                totalDurationSec = estTotal;
                airportWaitSeconds = estTotal - moveDurationSec;
              }
            } catch {
              // ignore and keep using moveDurationSec
            }
          }

          const durationSec = totalDurationSec;

          cumulativeDistanceKm += typeof distanceTripKm === "number" ? distanceTripKm : 0;

          const startTime = r.reservationTime;
          const endTime = startTime + durationSec;

          const batteryAfterKm = options && typeof options.defaultRangeKm === "number"
            ? Math.max(options.defaultRangeKm - cumulativeDistanceKm, 0)
            : null;
          const batteryBeforeKm =
            batteryAfterKm != null && typeof distanceTripKm === "number"
              ? batteryAfterKm + distanceTripKm
              : null;

          const segment = {
            type: "trip",
            fromAddress:
              (r.origin && (r.origin.address || r.origin.name)) ||
              "起點",
            toAddress:
              (r.dest && (r.dest.address || r.dest.name)) ||
              "終點",
            distanceKm: typeof distanceTripKm === "number" ? distanceTripKm : 0,
            durationSec,
            startTime,
            endTime,
            batteryAfterKm,
            batteryBeforeKm,
            airportWaitSeconds,
          };
          if (breakdown) {
            segment.estimatedSpeedKmh = breakdown.estimatedSpeedKmh;
            segment.hourFactorMinutes = breakdown.hourFactorMinutes;
            segment.regionMinutes = breakdown.regionMinutes;
            segment.extraReason = breakdown.extraReason;
            segment.extraDurationSec = breakdown.extraSec;
            segment.baseDurationSec = breakdown.baseSec;
          }

          const tripEntry = {
            reservationId: r.id,
            reservation: r,
            segments: [segment],
          };

          trips.push(tripEntry);
          timelineItems.push({
            type: "trip",
            reservation: r,
            segments: [segment],
            batteryAfterKm,
          });
        });

      const allSegmentsFallback = trips.flatMap((t) => t.segments);
      if (allSegmentsFallback.length > 0) {
        totalDistanceKm = allSegmentsFallback.reduce((s, seg) => s + (seg.distanceKm || 0), 0);
        totalDrivingMinutes =
          Math.round((allSegmentsFallback.reduce((s, seg) => s + (seg.durationSec || 0), 0) / 60) * 10) / 10;
      }
    }

    // 若目前 timelineItems 中尚未有任何 transit，使用「相鄰節點掃描」的方式統一建立行程間移動項目
    const hasTransit = timelineItems.some((it) => it && it.type === "transit");
    if (!hasTransit && timelineItems.length > 1) {
      const sortedTimeline = timelineItems.slice().sort((a, b) => {
        const ta = a && typeof a.startTime === "number" ? a.startTime : 0;
        const tb = b && typeof b.startTime === "number" ? b.startTime : 0;
        return ta - tb;
      });

      const enriched = [];
      for (let i = 0; i < sortedTimeline.length; i++) {
        const curr = sortedTimeline[i];
        if (!curr) continue;
        if (i > 0) {
          const prev = sortedTimeline[i - 1];
          if (prev && curr.type === "trip") {
            let prevEndGeo = null;
            let prevEndLabel = null;
            let prevEndTime = null;
            let batteryBeforeKm = null;

            if (prev.type === "trip" && prev.reservation) {
              const rPrev = prev.reservation;
              const fullPrev =
                resById[rPrev.id] ||
                resById[String(rPrev.id)] ||
                rPrev;
              if (fullPrev && fullPrev.dest && fullPrev.dest.geo) {
                prevEndGeo = fullPrev.dest.geo;
                prevEndLabel =
                  (fullPrev.dest.address || fullPrev.dest.name) ||
                  (fullPrev.origin && (fullPrev.origin.address || fullPrev.origin.name)) ||
                  "上一趟行程終點";
              }
              if (prev.segments && prev.segments[0]) {
                const segPrev = prev.segments[0];
                if (typeof segPrev.endTime === "number" && segPrev.endTime > 0) {
                  prevEndTime = segPrev.endTime;
                }
                if (typeof segPrev.batteryAfterKm === "number") {
                  batteryBeforeKm = segPrev.batteryAfterKm;
                }
              }
            } else if (prev.type === "charging" && prev.chargingCalculation) {
              const cc = prev.chargingCalculation;
              prevEndGeo = null; // 沒有明確座標，僅能用距離與時間推估
              prevEndLabel = "充電地點";
              prevEndTime = typeof prev.endTime === "number" ? prev.endTime : null;
              if (typeof cc.rangeAfterComputed === "number") {
                batteryBeforeKm = cc.rangeAfterComputed;
              } else if (typeof prev.rangeAfterKm === "number") {
                batteryBeforeKm = prev.rangeAfterKm;
              }
            }

            const currRes = curr.reservation;
            const fullCurr =
              currRes &&
              (resById[currRes.id] ||
                resById[String(currRes.id)] ||
                currRes);

            if (fullCurr && fullCurr.origin && fullCurr.origin.geo) {
              let transitDistanceKm = null;
              let transitDurationSec = null;
              let transitBreakdownForItem = null;

              // 若有明確的前一段終點座標，使用 geo breakdown 計算
              if (prevEndGeo) {
                try {
                  const bd = getPointToPointDurationBreakdown(
                    prevEndGeo,
                    fullCurr.origin.geo,
                    prevEndTime || fullCurr.reservationTime || 0
                  );
                  if (bd && typeof bd.totalSec === "number" && bd.totalSec > 0) {
                    transitBreakdownForItem = bd;
                    transitDurationSec = bd.totalSec;
                    if (typeof bd.distanceKm === "number") {
                      transitDistanceKm = bd.distanceKm;
                    }
                  }
                } catch {
                  transitBreakdownForItem = null;
                }

                if (transitDistanceKm == null) {
                  transitDistanceKm = getDistance(prevEndGeo, fullCurr.origin.geo);
                }
                if (transitDurationSec == null && transitDistanceKm != null) {
                  const est = estimatePointToPointDuration(
                    prevEndGeo,
                    fullCurr.origin.geo,
                    prevEndTime || fullCurr.reservationTime || 0
                  );
                  if (typeof est === "number" && est > 0) {
                    transitDurationSec = est;
                  }
                }
              } else if (prev.type === "charging" && prev.chargingCalculation && prev.chargingCalculation.transitBreakdown) {
                // 若為充電之後，優先使用主演算法在 chargingDebug 中提供的 transitBreakdown
                const b = prev.chargingCalculation.transitBreakdown;
                if (b && typeof b.distanceKm === "number" && typeof b.totalSec === "number") {
                  transitDistanceKm = b.distanceKm;
                  transitDurationSec = b.totalSec;
                  transitBreakdownForItem = {
                    distanceKm: b.distanceKm,
                    estimatedSpeedKmh: b.estimatedSpeedKmh,
                    baseSec: b.baseSec,
                    extraSec: b.extraSec,
                    extraReason: b.extraReason,
                    hourFactorMinutes: b.hourFactorMinutes,
                    regionMinutes: b.regionMinutes,
                  };
                }
              }

              if (transitDistanceKm != null && transitDurationSec != null) {
                const batteryAfterKmTransit =
                  typeof batteryBeforeKm === "number"
                    ? Math.max(0, batteryBeforeKm - transitDistanceKm)
                    : null;

                const transitItem = createTransitTimelineItem({
                  fromAddress:
                    prevEndLabel ||
                    (fullCurr.origin.address || fullCurr.origin.name) ||
                    "上一趟行程終點",
                  fromGeo: prevEndGeo || null,
                  toAddress:
                    (fullCurr.origin.address || fullCurr.origin.name) ||
                    "下一趟行程起點",
                  toGeo: fullCurr.origin.geo || null,
                  startTime: prevEndTime || fullCurr.reservationTime || 0,
                  endTime: (prevEndTime || fullCurr.reservationTime || 0) + transitDurationSec,
                  distanceKm: transitDistanceKm,
                  durationSec: transitDurationSec,
                  batteryBeforeKm,
                  batteryAfterKm: batteryAfterKmTransit,
                  breakdown: transitBreakdownForItem,
                });

                enriched.push(transitItem);
              }
            }
          }

          enriched.push(curr);
        } else {
          enriched.push(curr);
        }
      }

      if (enriched.length > 0) {
        timelineItems.length = 0;
        enriched.forEach((it) => timelineItems.push(it));
      }
    }

    const allSegments = trips.flatMap((t) => t.segments);

    // ===============
    // 可塞入假行程時間窗（可多段）
    // ===============
    let insertableSlots = [];
    try {
      insertableSlots = computeInsertableSlots({
        driverId: key,
        timelineItems,
        homeGeo,
        shiftBeginUnix,
        shiftEndUnix,
        options,
        debugLog,
      });
    } catch {
      // ignore slot errors in demo mode
    }

    debugByDriver[key] = {
      driverId: key,
      totalDistanceKm,
      totalDrivingMinutes:
        Math.round((allSegments.reduce((s, seg) => s + seg.durationSec, 0) / 60) * 10) / 10,
      chargingSegments,
      totalChargingMinutes:
        Math.round(
          (chargingSegments.reduce((s, seg) => s + seg.durationSec, 0) / 60) * 10
        ) / 10,
      workHoursLabel,
      trips,
      timelineItems,
      insertableSlots,
    };
  });

  return debugByDriver;
}

/**
 * 封裝排程執行入口
 * @param {Array} reservations 來自 ZEMO API 的預約資料（需包含 reservationTime、origin/dest 等欄位）
 * @param {Array} driverShifts 來自 ZEMO API 的司機班表（需包含 driverId、shift、homeLocation、vehicleType）
 * @param {Object} overrides 針對本次排程欲覆寫的選項（可留空）
 * @returns {Promise<{schedule:Object, unassignedReservations:Array, summary:Object}>}
 */
async function runSchedule(reservations, driverShifts, overrides = {}) {
  const env = getConfig();

  // 在每次排程前，依據目前 demo 設定覆寫企業／司機優先度常數
  applyPriorityAndDriverConstantsFromConfig(env);

  const options = {
    schedulingAlgorithm: "proximity",
    enableVehicleTypeRouting: env.enableVehicleTypeRouting,
    enableGapFilling: env.enableGapFilling,
    enablePriorityBasedScheduling: env.enablePriorityBasedScheduling,
    enableGapFillingBatteryValidation: env.enableGapFillingBatteryValidation,
    sortLowPriorityReservationsByTime: env.sortLowPriorityReservationsByTime,
    checkBatteryRange: env.checkBatteryRange !== false,
    minimumIdleTimeToChargeSeconds: env.minimumIdleTimeToChargeSeconds,
    estimatedTimeToFindChargingStationSeconds: env.estimatedTimeToFindChargingStationSeconds,
    defaultRangeKm: env.defaultRangeKm,
    ...overrides,
  };

  // 企業優先度：若啟用 enablePriorityBasedScheduling，則依 highPriorityEnterpriseIds 先排序預約
  let reservationsForRun = reservations || [];
  if (options.enablePriorityBasedScheduling && env.highPriorityEnterpriseIdsCsv) {
    const ids = String(env.highPriorityEnterpriseIdsCsv)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => Number(s))
      .filter((n) => !Number.isNaN(n));
    const highSet = new Set(ids);

    if (highSet.size > 0) {
      const high = [];
      const normal = [];
      reservationsForRun.forEach((r) => {
        const eid = r && r.enterpriseId != null ? Number(r.enterpriseId) : null;
        if (eid != null && highSet.has(eid)) {
          high.push(r);
        } else {
          normal.push(r);
        }
      });

      high.sort((a, b) => (a.reservationTime || 0) - (b.reservationTime || 0));
      normal.sort((a, b) => (a.reservationTime || 0) - (b.reservationTime || 0));
      reservationsForRun = [...high, ...normal];
    }
  }

  let coreResult;
  if (options.enableVehicleTypeRouting) {
    coreResult = vehicleRoutingScheduler(reservationsForRun, driverShifts, proximitySchedulingAlgorithm, options);
  } else {
    coreResult = proximitySchedulingAlgorithm(reservationsForRun, driverShifts, options);
  }

  const schedule = coreResult.scheduleResult || coreResult.schedule || {};
  const unassignedReservations = coreResult.unassignedReservations || [];

  const driverIds = Object.keys(schedule);
  const totalAssigned = driverIds.reduce((sum, id) => {
    const s = schedule[id];
    const reservationsForDriver = s && Array.isArray(s.reservations) ? s.reservations.length : 0;
    return sum + reservationsForDriver;
  }, 0);

  const summary = {
    driverCount: driverIds.length,
    totalReservations: reservations.length,
    assignedReservations: totalAssigned,
    unassignedReservations: unassignedReservations.length,
    areCompatible: coreResult.areCompatible ?? coreResult.isCompatible ?? null,
  };

  const debug = buildDriverDebug(schedule, driverShifts, reservations, options);

  return {
    schedule,
    unassignedReservations,
    summary,
    debug,
  };
}

module.exports = {
  runSchedule,
};


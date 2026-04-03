"use strict";

const moment = require("moment-timezone");
const config = require("../config");

/**
 * 合併重疊/相鄰的時間區間
 * @param {Array<{start: number, end: number}>} intervals - unix timestamps
 * @returns {Array<{start: number, end: number}>}
 */
function mergeIntervals(intervals) {
  if (!intervals || intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/**
 * 在 [dayStart, dayEnd] 範圍內取補集
 * @param {Array<{start: number, end: number}>} intervals - 已合併的區間
 * @param {number} dayStart - unix timestamp (00:00)
 * @param {number} dayEnd   - unix timestamp (23:59)
 * @returns {Array<{start: number, end: number}>}
 */
function complementIntervals(intervals, dayStart, dayEnd) {
  if (!intervals || intervals.length === 0) {
    return [{ start: dayStart, end: dayEnd }];
  }

  const pauses = [];
  const sorted = mergeIntervals(intervals);

  // 第一段之前
  if (sorted[0].start > dayStart) {
    pauses.push({ start: dayStart, end: sorted[0].start });
  }

  // 段與段之間
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].end < sorted[i + 1].start) {
      pauses.push({ start: sorted[i].end, end: sorted[i + 1].start });
    }
  }

  // 最後一段之後
  if (sorted[sorted.length - 1].end < dayEnd) {
    pauses.push({ start: sorted[sorted.length - 1].end, end: dayEnd });
  }

  return pauses;
}

/**
 * 從排程結果中，聚合所有駕駛的 insertableSlots → 算出每個分類的暫停銷售段
 *
 * @param {Object} debug - runSchedule() 回傳的 debug（每位駕駛的 debug entry）
 * @param {Array} driverShifts - 駕駛班表陣列
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Object} { "STANDARD_dropoff": [{start, end}], ... }
 */
function computePausePeriodsForDate(debug, driverShifts, dateStr) {
  const midnight = moment.tz(dateStr, config.TIMEZONE).startOf("day").unix();
  const dayStart = midnight + (config.SALES_START_HOUR || 4) * 3600; // 銷售起始時間（預設 04:00）
  const dayEnd = midnight + 23 * 3600 + 59 * 60; // 23:59

  // 建立 driverId → vehicleType map
  const vehicleTypeMap = {};
  (driverShifts || []).forEach((ds) => {
    const did = String(ds.driverId);
    vehicleTypeMap[did] = ds.vehicleType || "STANDARD";
  });

  // 判斷各車種是否有駕駛上班
  const hasDriverByType = {};
  for (const cat of config.CATEGORIES) {
    hasDriverByType[cat.key] = (driverShifts || []).some(
      (ds) => (ds.vehicleType || "STANDARD") === cat.vehicleType
    );
  }

  const result = {};
  const ONE_MIN = 60;

  for (const cat of config.CATEGORIES) {
    // 當日該車種無任何駕駛 → 不需設定暫停銷售（視為不營運）
    if (!hasDriverByType[cat.key]) {
      result[cat.key] = [];
      continue;
    }

    // 收集該車種所有駕駛的 insertable windows
    const allWindows = [];

    Object.entries(debug || {}).forEach(([driverId, dbg]) => {
      const vType = vehicleTypeMap[String(driverId)] || "STANDARD";
      if (vType !== cat.vehicleType) return;

      const slots = dbg.insertableSlots || [];
      slots
        .filter((s) => s.tripType === cat.tripType)
        .forEach((slot) => {
          (slot.windows || []).forEach((w) => {
            if (typeof w.startTime === "number" && typeof w.endTime === "number") {
              allWindows.push({ start: w.startTime, end: w.endTime });
            }
          });
        });
    });

    // 合併可售時段 → 取補集 = 暫停段
    // 暫停段邊界退讓 1 分鐘，避免與可售時段分鐘重疊
    // 例如可售 02:27~03:18 → 暫停為 ...~02:26 和 03:19~...
    const mergedAvailable = mergeIntervals(allWindows);
    const rawPauses = [];

    if (mergedAvailable.length === 0) {
      rawPauses.push({ start: dayStart, end: dayEnd });
    } else {
      // 第一段可售之前
      if (mergedAvailable[0].start > dayStart) {
        rawPauses.push({ start: dayStart, end: mergedAvailable[0].start - ONE_MIN });
      }
      // 段與段之間
      for (let i = 0; i < mergedAvailable.length - 1; i++) {
        const pauseStart = mergedAvailable[i].end + ONE_MIN;
        const pauseEnd = mergedAvailable[i + 1].start - ONE_MIN;
        if (pauseStart <= pauseEnd) {
          rawPauses.push({ start: pauseStart, end: pauseEnd });
        }
      }
      // 最後一段可售之後
      if (mergedAvailable[mergedAvailable.length - 1].end < dayEnd) {
        rawPauses.push({ start: mergedAvailable[mergedAvailable.length - 1].end + ONE_MIN, end: dayEnd });
      }
    }

    // 合併相鄰暫停段（間隔 ≤ 60 秒視為連續）
    const pausePeriods = [];
    for (const p of rawPauses) {
      if (p.start > p.end) continue; // 退讓後可能變成無效區間
      if (pausePeriods.length > 0 && p.start - pausePeriods[pausePeriods.length - 1].end <= ONE_MIN) {
        pausePeriods[pausePeriods.length - 1].end = p.end;
      } else {
        pausePeriods.push({ ...p });
      }
    }

    result[cat.key] = pausePeriods;
  }

  return result;
}

module.exports = {
  mergeIntervals,
  complementIntervals,
  computePausePeriodsForDate,
};

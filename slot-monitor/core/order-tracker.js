"use strict";

/**
 * 偵測新訂單是否落入暫停銷售時段
 *
 * @param {Array} reservations - 當天所有預約
 * @param {Object} pausePeriodsMap - { "STANDARD_dropoff": [{start,end}], ... }
 * @param {Object} prevOrderIdsMap - { "STANDARD_dropoff": [id1, id2, ...], ... }
 * @param {Array} categories - config.CATEGORIES
 * @returns {Object} { "STANDARD_dropoff": [{id, reservationTime}], ... }
 */
function findNewOrdersInPausedZones(reservations, pausePeriodsMap, prevOrderIdsMap, categories) {
  const result = {};

  for (const cat of categories) {
    const pauses = pausePeriodsMap[cat.key] || [];
    const prevIds = new Set((prevOrderIdsMap[cat.key] || []).map(String));
    const newOrdersInPause = [];

    for (const r of reservations) {
      // 跳過已知的訂單
      if (prevIds.has(String(r.id))) continue;

      // 根據訂單車型過濾：只比對對應類別
      const orderVehicle = r.requiredVehicleType; // "STANDARD" / "LARGE" / null
      if (orderVehicle && orderVehicle !== cat.vehicleType) continue;

      const t = r.reservationTime;
      // 檢查是否落入暫停段（連同暫停段一起回傳，方便通知顯示）
      for (const p of pauses) {
        if (t >= p.start && t < p.end) {
          newOrdersInPause.push({
            id: r.id,
            reservationTime: t,
            pausePeriod: { start: p.start, end: p.end },
          });
          break;
        }
      }
    }

    result[cat.key] = newOrdersInPause;
  }

  return result;
}

module.exports = { findNewOrdersInPausedZones };

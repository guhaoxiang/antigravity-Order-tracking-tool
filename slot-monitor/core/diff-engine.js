"use strict";

const moment = require("moment-timezone");
const config = require("../config");

/**
 * 將暫停段展開為分鐘索引 Set（0~1439）
 * @param {Array<{start: number, end: number}>} periods - unix timestamps
 * @param {number} dayStartUnix - 當天 00:00 的 unix timestamp
 * @returns {Set<number>}
 */
function expandToMinuteSet(periods, dayStartUnix) {
  const set = new Set();
  for (const p of periods || []) {
    const startMin = Math.max(0, Math.floor((p.start - dayStartUnix) / 60));
    const endMin = Math.min(1440, Math.ceil((p.end - dayStartUnix) / 60));
    for (let m = startMin; m < endMin; m++) {
      set.add(m);
    }
  }
  return set;
}

/**
 * 將分鐘索引 Set 合回連續的暫停段
 * @param {Set<number>} minuteSet
 * @param {number} dayStartUnix
 * @returns {Array<{start: number, end: number}>}
 */
function mergeMinutesToPeriods(minuteSet, dayStartUnix) {
  if (minuteSet.size === 0) return [];
  const sorted = [...minuteSet].sort((a, b) => a - b);
  const periods = [];
  let rangeStart = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      periods.push({
        start: dayStartUnix + rangeStart * 60,
        end: dayStartUnix + (prev + 1) * 60,
      });
      rangeStart = sorted[i];
      prev = sorted[i];
    }
  }
  periods.push({
    start: dayStartUnix + rangeStart * 60,
    end: dayStartUnix + (prev + 1) * 60,
  });

  return periods;
}

/**
 * 比對前後兩組暫停段的差異（以「整段」為單位）
 *
 * 設計理念：後台的每一筆暫停銷售是獨立的設定項，邊界若有移動，就必須
 * 整段移除再整段新增（分鐘級的 delta 對 operator 沒意義）。
 * 因此這裡以「起訖分鐘都相同」才判定為同一段；任一邊界改變就視為移除舊段＋新增新段。
 *
 * @param {Array<{start,end}>|null} prevPeriods - 上次通知的暫停段（null = 首次）
 * @param {Array<{start,end}>} currPeriods - 這次算出的暫停段
 * @param {number} dayStartUnix - 當天 00:00 unix timestamp（目前未使用，保留簽名相容）
 * @returns {{ isNew: boolean, hasChanges: boolean, removed: Array, added: Array, current: Array }}
 */
function diffPausePeriods(prevPeriods, currPeriods, dayStartUnix) {
  const curr = currPeriods || [];

  // 首次（Supabase 無紀錄）
  if (prevPeriods === null || prevPeriods === undefined) {
    return {
      isNew: true,
      hasChanges: curr.length > 0,
      removed: [],
      added: curr,
      current: curr,
    };
  }

  const prev = prevPeriods || [];

  // 對齊到分鐘邊界後比對（避免秒級抖動造成假差異）
  const toMinute = (p) => ({
    start: Math.round(p.start / 60) * 60,
    end: Math.round(p.end / 60) * 60,
  });
  const key = (p) => `${p.start}-${p.end}`;

  const prevNorm = prev.map(toMinute);
  const currNorm = curr.map(toMinute);
  const prevKeys = new Set(prevNorm.map(key));
  const currKeys = new Set(currNorm.map(key));

  const removed = prevNorm.filter((p) => !currKeys.has(key(p)));
  const added = currNorm.filter((p) => !prevKeys.has(key(p)));

  return {
    isNew: false,
    hasChanges: removed.length > 0 || added.length > 0,
    removed,
    added,
    current: curr,
  };
}

module.exports = {
  expandToMinuteSet,
  mergeMinutesToPeriods,
  diffPausePeriods,
};

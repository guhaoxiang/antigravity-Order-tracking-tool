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
 * 比對前後兩組暫停段的差異
 * @param {Array<{start,end}>|null} prevPeriods - 上次通知的暫停段（null = 首次）
 * @param {Array<{start,end}>} currPeriods - 這次算出的暫停段
 * @param {number} dayStartUnix - 當天 00:00 unix timestamp
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
  const prevSet = expandToMinuteSet(prev, dayStartUnix);
  const currSet = expandToMinuteSet(curr, dayStartUnix);

  // 計算集合差異
  const removedMinutes = new Set();
  for (const m of prevSet) {
    if (!currSet.has(m)) removedMinutes.add(m);
  }

  const addedMinutes = new Set();
  for (const m of currSet) {
    if (!prevSet.has(m)) addedMinutes.add(m);
  }

  const removed = mergeMinutesToPeriods(removedMinutes, dayStartUnix);
  const added = mergeMinutesToPeriods(addedMinutes, dayStartUnix);

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

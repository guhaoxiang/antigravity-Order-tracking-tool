"use strict";

const { createClient } = require("@supabase/supabase-js");
const config = require("../config");

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);
const TABLE = config.SUPABASE_TABLE;

/**
 * 取得指定分類+日期的上次狀態
 * @param {string} category - e.g. "STANDARD_dropoff"
 * @param {string} dateStr  - "YYYY-MM-DD"
 * @returns {Promise<{pausePeriods: Array, orderIds: Array} | null>}
 */
async function getState(category, dateStr) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("pause_periods, order_ids")
    .eq("category", category)
    .eq("date", dateStr)
    .maybeSingle();

  if (error) {
    console.error(`[supabase] getState error (${category}, ${dateStr}):`, error.message);
    return null;
  }
  if (!data) return null;

  return {
    pausePeriods: data.pause_periods || [],
    orderIds: data.order_ids || [],
  };
}

/**
 * 寫入/更新指定分類+日期的狀態
 * @param {string} category
 * @param {string} dateStr
 * @param {Array} pausePeriods
 * @param {Array} orderIds
 */
async function upsertState(category, dateStr, pausePeriods, orderIds) {
  const { error } = await supabase.from(TABLE).upsert(
    {
      category,
      date: dateStr,
      pause_periods: pausePeriods,
      order_ids: orderIds,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "category,date" }
  );

  if (error) {
    console.error(`[supabase] upsertState error (${category}, ${dateStr}):`, error.message);
  }
}

/**
 * 清理過期的 state（刪除指定日期之前的資料）
 * @param {string} beforeDateStr - "YYYY-MM-DD"
 */
async function cleanupOldDates(beforeDateStr) {
  const { error, count } = await supabase
    .from(TABLE)
    .delete()
    .lt("date", beforeDateStr);

  if (error) {
    console.error("[supabase] cleanupOldDates error:", error.message);
  } else if (count > 0) {
    console.log(`[supabase] cleaned up ${count} old rows (before ${beforeDateStr})`);
  }
}

/**
 * 清除所有通知紀錄（重置所有狀態）
 * @returns {Promise<number>} 刪除的筆數
 */
async function clearAllState() {
  const { data, error, count } = await supabase
    .from(TABLE)
    .delete()
    .neq("id", 0)  // 刪除所有 row
    .select("id");

  if (error) {
    console.error("[supabase] clearAllState error:", error.message);
    return 0;
  }
  return data ? data.length : 0;
}

module.exports = {
  getState,
  upsertState,
  cleanupOldDates,
  clearAllState,
};

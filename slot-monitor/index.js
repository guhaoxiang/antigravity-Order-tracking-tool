"use strict";

const moment = require("moment-timezone");
const config = require("./config");
const { computePausePeriodsForDate } = require("./core/slot-aggregator");
const { diffPausePeriods } = require("./core/diff-engine");
const { getState, upsertState, cleanupOldDates, clearAllState } = require("./core/supabase-state");
const {
  formatCombinedNewNotifications,
  formatCombinedChangedNotifications,
  formatCombinedOrderAlertNotifications,
  formatErrorNotification,
  sendAllNotifications,
  sendSlackMessage,
} = require("./core/slack-notifier");
const { findNewOrdersInPausedZones } = require("./core/order-tracker");

const { prefetchDriverData, fetchReservationsWithPrefetchedDrivers } = require("../scheduler-web-demo/core/zemo-client");
const { runSchedule } = require("../scheduler-web-demo/core/scheduler-engine");
const { getConfig } = require("../scheduler-web-demo/core/env-config");

function applyGeoConfigToProcessEnv(cfg) {
  if (cfg.geoRushHourMinutes != null) process.env.GEO_RUSH_HOUR_MINUTES = String(cfg.geoRushHourMinutes);
  if (cfg.geoLightHourMinutes != null) process.env.GEO_LIGHT_HOUR_MINUTES = String(cfg.geoLightHourMinutes);
  if (cfg.geoEstimatedSpeedBands != null)
    process.env.GEO_ESTIMATED_SPEED_BANDS =
      typeof cfg.geoEstimatedSpeedBands === "string" ? cfg.geoEstimatedSpeedBands : JSON.stringify(cfg.geoEstimatedSpeedBands);
  if (cfg.rushHourMorningStart) process.env.GEO_RUSH_HOUR_MORNING_START = cfg.rushHourMorningStart;
  if (cfg.rushHourMorningEnd) process.env.GEO_RUSH_HOUR_MORNING_END = cfg.rushHourMorningEnd;
  if (cfg.rushHourEveningStart) process.env.GEO_RUSH_HOUR_EVENING_START = cfg.rushHourEveningStart;
  if (cfg.rushHourEveningEnd) process.env.GEO_RUSH_HOUR_EVENING_END = cfg.rushHourEveningEnd;
  if (cfg.lightHourEarlyEnd) process.env.GEO_LIGHT_HOUR_EARLY_END = cfg.lightHourEarlyEnd;
  if (cfg.lightHourLateStart) process.env.GEO_LIGHT_HOUR_LATE_START = cfg.lightHourLateStart;
}

// ── 重試風暴防護：全域逾時 ──
const PROCESS_TIMEOUT = parseInt(process.env.PROCESS_TIMEOUT_MS, 10) || 300000; // 5 分鐘
let processTimer;

function startProcessTimeout() {
  processTimer = setTimeout(() => {
    console.error(`[TIMEOUT] 執行超過 ${PROCESS_TIMEOUT / 1000} 秒，強制結束以避免費用暴增`);
    process.exit(2);
  }, PROCESS_TIMEOUT);
  // 允許 process 在 timer 前正常結束
  processTimer.unref();
}

// ── 重試風暴防護：單日處理逾時 ──
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[TIMEOUT] ${label} 超過 ${ms / 1000} 秒`)), ms)
    ),
  ]);
}

async function main() {
  startProcessTimeout();
  const args = process.argv.slice(2);

  if (args.includes("--reset")) {
    console.log("正在清除所有通知紀錄...");
    const count = await clearAllState();
    console.log(`已清除 ${count} 筆紀錄。下次執行將重新發送所有通知。`);
    process.exit(0);
    return;
  }

  const dryRun = args.includes("--dry-run");
  const daysOverride = args.find((a) => a.startsWith("--days"));
  const daysAhead = daysOverride
    ? parseInt(daysOverride.split("=")[1] || daysOverride.replace("--days", "").trim(), 10) || 1
    : config.DAYS_AHEAD;

  console.log("══════════════════════════════════════════════");
  console.log("  Slot Monitor - 暫停銷售自動通知");
  console.log(`  模式: ${dryRun ? "DRY RUN" : "正式執行"}`);
  console.log(`  日期範圍: 明天起 ${daysAhead} 天`);
  console.log(`  開始時間: ${moment().tz(config.TIMEZONE).format("YYYY-MM-DD HH:mm:ss")}`);
  console.log("══════════════════════════════════════════════");

  const demoConfig = getConfig();
  applyGeoConfigToProcessEnv(demoConfig);

  // 從 Supabase 設定讀取 Slack Channel ID（設定頁面可修改，優先於環境變數）
  if (demoConfig.slackChannelId) {
    config.SLACK_CHANNEL_ID = demoConfig.slackChannelId;
  }

  const today = moment().tz(config.TIMEZONE);
  const dates = [];
  for (let d = 1; d <= daysAhead; d++) {
    dates.push(today.clone().add(d, "days").format("YYYY-MM-DD"));
  }

  // ── 預先載入駕駛資料（只呼叫一次 API）──
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  console.log(`  預載駕駛資料 (${firstDate} ~ ${lastDate})...`);
  const prefetched = await prefetchDriverData(firstDate, lastDate);
  if (prefetched.warning) console.log(`  ⚠ ${prefetched.warning}`);
  console.log(`  駕駛: ${prefetched.userList.length} 位\n`);

  // ── 階段一：逐日處理，收集所有差異 ──
  const newPeriodsByCategory = {};
  const changedAddedByCategory = {};
  const changedRemovedByCategory = {};
  const orderAlertsByCategory = {};
  const stateUpdates = [];

  let errorCount = 0;
  let processedCount = 0;

  // 並行處理（每批 5 天）
  const BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < dates.length; batchStart += BATCH_SIZE) {
    const batch = dates.slice(batchStart, batchStart + BATCH_SIZE);
    const PER_DATE_TIMEOUT = 60000; // 每天最多 60 秒
    const results = await Promise.allSettled(
      batch.map(async (dateStr) => {
        const { reservations, driverShifts } = await withTimeout(
          fetchReservationsWithPrefetchedDrivers(dateStr, prefetched),
          PER_DATE_TIMEOUT,
          `fetch ${dateStr}`
        );

        let pausePeriodsMap = {};
        const dayStartUnix = moment.tz(dateStr, config.TIMEZONE).startOf("day").unix();

        if (reservations.length === 0) {
          for (const cat of config.CATEGORIES) pausePeriodsMap[cat.key] = [];
        } else {
          const result = await runSchedule(reservations, driverShifts, demoConfig);
          pausePeriodsMap = computePausePeriodsForDate(result.debug || {}, driverShifts, dateStr);
        }

        return { dateStr, reservations, driverShifts, pausePeriodsMap, dayStartUnix };
      })
    );

    for (const settled of results) {
      if (settled.status === "rejected") {
        errorCount++;
        console.log(`  ✗ (${settled.reason?.message || settled.reason})`);
        continue;
      }

      const { dateStr, reservations, pausePeriodsMap, dayStartUnix } = settled.value;
      const currentOrderIds = reservations.map((r) => r.id);

      for (const cat of config.CATEGORIES) {
        const currPauses = pausePeriodsMap[cat.key] || [];
        const prevState = await getState(cat.key, dateStr);
        const prevPauses = prevState ? prevState.pausePeriods : null;
        const prevOrderIds = prevState ? prevState.orderIds : [];

        const diff = diffPausePeriods(prevPauses, currPauses, dayStartUnix);

        if (diff.isNew && diff.hasChanges) {
          if (!newPeriodsByCategory[cat.label]) newPeriodsByCategory[cat.label] = [];
          newPeriodsByCategory[cat.label].push(...diff.current);
        } else if (!diff.isNew && diff.hasChanges) {
          if (diff.added.length > 0) {
            if (!changedAddedByCategory[cat.label]) changedAddedByCategory[cat.label] = [];
            changedAddedByCategory[cat.label].push(...diff.added);
          }
          if (diff.removed.length > 0) {
            if (!changedRemovedByCategory[cat.label]) changedRemovedByCategory[cat.label] = [];
            changedRemovedByCategory[cat.label].push(...diff.removed);
          }
        }

        if (!diff.isNew) {
          const prevOrderIdsMap = { [cat.key]: prevOrderIds };
          const newOrdersMap = findNewOrdersInPausedZones(reservations, pausePeriodsMap, prevOrderIdsMap, [cat]);
          const newOrders = newOrdersMap[cat.key] || [];
          if (newOrders.length > 0) {
            if (!orderAlertsByCategory[cat.label]) orderAlertsByCategory[cat.label] = [];
            orderAlertsByCategory[cat.label].push(...newOrders);
          }
        }

        if (diff.hasChanges || diff.isNew || currentOrderIds.length !== prevOrderIds.length) {
          stateUpdates.push({ category: cat.key, date: dateStr, pauses: currPauses, orderIds: currentOrderIds });
        }
      }

      processedCount++;
    }

    // 進度顯示
    const done = Math.min(batchStart + BATCH_SIZE, dates.length);
    process.stdout.write(`  ${done}/${dates.length} 天完成\r`);
  }
  console.log("");

  // ── 階段二：統一發送 Slack 通知 ──
  const allMessages = [];

  // 報單警告（首次）
  const newMsgs = formatCombinedNewNotifications(newPeriodsByCategory);
  allMessages.push(...newMsgs);

  // 暫停銷售變更
  const changedMsgs = formatCombinedChangedNotifications(changedRemovedByCategory, changedAddedByCategory);
  allMessages.push(...changedMsgs);

  // 訂單異動
  const orderMsgs = formatCombinedOrderAlertNotifications(orderAlertsByCategory);
  allMessages.push(...orderMsgs);

  // 如果處理過程有錯誤，也要回報
  if (errorCount > 0 && !dryRun) {
    const errMsg = formatErrorNotification(
      "排程處理失敗",
      `${dates.length} 天中有 ${errorCount} 天處理失敗，${processedCount} 天成功。請檢查系統日誌。`
    );
    allMessages.push(errMsg);
  }

  if (allMessages.length > 0) {
    console.log(`\n  📤 發送 ${allMessages.length} 則 Slack 通知...`);
    if (dryRun) {
      allMessages.forEach((m) => console.log("\n--- DRY RUN ---\n" + m));
    } else {
      const result = await sendAllNotifications(allMessages);
      if (result.allOk) {
        console.log(`  ✓ Slack 發送成功（${result.sent} 則）`);
      } else {
        console.log(`  ⚠ Slack 發送：${result.sent} 則成功、${result.failed} 則失敗`);
      }
    }
  } else {
    console.log("\n  無變更，不發送通知");
  }

  // ── 階段三：更新 Supabase 狀態 ──
  if (!dryRun && stateUpdates.length > 0) {
    for (const u of stateUpdates) {
      await upsertState(u.category, u.date, u.pauses, u.orderIds);
    }
    console.log(`  ✓ 更新 ${stateUpdates.length} 筆 Supabase 狀態`);
  }

  // 清理過期
  if (!dryRun) {
    const yesterday = today.clone().subtract(1, "day").format("YYYY-MM-DD");
    await cleanupOldDates(yesterday);
  }

  console.log("");
  console.log("══════════════════════════════════════════════");
  console.log(`  完成：${processedCount} 天成功，${errorCount} 天失敗`);
  console.log(`  通知：${allMessages.length} 則`);
  console.log(`  結束時間: ${moment().tz(config.TIMEZONE).format("YYYY-MM-DD HH:mm:ss")}`);
  console.log("══════════════════════════════════════════════");

  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  // 嘗試發送致命錯誤通知到 Slack
  try {
    const errMsg = formatErrorNotification("系統崩潰", `${err.message || err}`);
    await sendSlackMessage(errMsg);
  } catch { /* Slack 也掛了，至少 console 有紀錄 */ }
  process.exit(1);
});

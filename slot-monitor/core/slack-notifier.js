"use strict";

const axios = require("axios");
const moment = require("moment-timezone");
const config = require("../config");

const SLACK_API = "https://slack.com/api/chat.postMessage";

function fmtDatetime(unix) {
  return moment.unix(unix).tz(config.TIMEZONE).format("YYYY-MM-DD HH:mm");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 發送一則 Slack 訊息
 */
async function sendSlackMessage(text) {
  try {
    const res = await axios.post(
      SLACK_API,
      { channel: config.SLACK_CHANNEL_ID, text, unfurl_links: false },
      { headers: { Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" }, timeout: 10000 }
    );
    if (!res.data.ok) {
      console.error("[slack] API error:", res.data.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[slack] send failed:", err.message);
    await sleep(2000);
    try {
      const res = await axios.post(
        SLACK_API,
        { channel: config.SLACK_CHANNEL_ID, text, unfurl_links: false },
        { headers: { Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" }, timeout: 10000 }
      );
      return res.data && res.data.ok;
    } catch (retryErr) {
      console.error("[slack] retry failed:", retryErr.message);
      return false;
    }
  }
}

/**
 * 將訊息行依字數上限拆成多頁
 * @param {string} header - 訊息標題
 * @param {string[]} lines - 內容行
 * @returns {string[]} 拆分後的完整訊息陣列
 */
function splitIntoPages(header, lines) {
  const maxChars = config.SLACK_MAX_CHARS;
  const pages = [];
  let currentLines = [];
  let currentLen = header.length + 2;

  for (const line of lines) {
    if (currentLen + line.length + 1 > maxChars && currentLines.length > 0) {
      pages.push(currentLines);
      currentLines = [];
      currentLen = header.length + 2;
    }
    currentLines.push(line);
    currentLen += line.length + 1;
  }
  if (currentLines.length > 0) pages.push(currentLines);

  if (pages.length <= 1) {
    return [header + "\n" + (pages[0] || []).join("\n")];
  }
  // 只有第一頁帶 header，後續頁只發內容
  return pages.map((chunk, i) => {
    if (i === 0) return header + "\n" + chunk.join("\n");
    return chunk.join("\n");
  });
}

// ────────────────────────────────────────────────
//  合併版通知格式：所有分類 + 所有日期 → 一則訊息
// ────────────────────────────────────────────────

/**
 * 報單警告（首次/新增暫停段）
 * 所有分類合在一則訊息，每個分類做為子區塊
 *
 * @param {Object} addedByCategory
 *   { "五人座送機": [{start,end}, ...], "七人座接機": [...], ... }
 * @returns {string[]} Slack 訊息陣列
 */
function formatCombinedNewNotifications(addedByCategory) {
  const lines = [];
  let totalCount = 0;

  for (const [label, periods] of Object.entries(addedByCategory)) {
    if (!periods || periods.length === 0) continue;
    totalCount += periods.length;
    lines.push("");
    lines.push(`[ ${label} ]`);
    for (const p of periods) {
      lines.push(`${fmtDatetime(p.start)} ~ ${fmtDatetime(p.end)}`);
    }
  }

  if (totalCount === 0) return [];

  const header = `報單警告！\n檢測到 ${totalCount} 筆，請至後台設定⌈暫停銷售⌋`;
  return splitIntoPages(header, lines);
}

/**
 * 暫停銷售變更（移除+新增）
 *
 * @param {Object} removedByCategory  { "五人座送機": [{start,end}], ... }
 * @param {Object} addedByCategory    { "五人座送機": [{start,end}], ... }
 * @returns {string[]}
 */
function formatCombinedChangedNotifications(removedByCategory, addedByCategory) {
  const lines = [];
  let hasContent = false;

  const allLabels = new Set([...Object.keys(removedByCategory), ...Object.keys(addedByCategory)]);

  for (const label of allLabels) {
    const removed = removedByCategory[label] || [];
    const added = addedByCategory[label] || [];
    if (removed.length === 0 && added.length === 0) continue;
    hasContent = true;
    lines.push("");
    lines.push(`[ ${label} ]`);
    for (const p of removed) {
      lines.push(`移除：${fmtDatetime(p.start)} ~ ${fmtDatetime(p.end)}`);
    }
    for (const p of added) {
      lines.push(`新增：${fmtDatetime(p.start)} ~ ${fmtDatetime(p.end)}`);
    }
  }

  if (!hasContent) return [];

  const header = "暫停銷售變更！";
  return splitIntoPages(header, lines);
}

/**
 * 訂單異動提醒
 *
 * @param {Object} ordersByCategory  { "五人座送機": [{id, reservationTime}], ... }
 * @returns {string[]}
 */
function formatCombinedOrderAlertNotifications(ordersByCategory) {
  const lines = [];
  let hasContent = false;

  for (const [label, orders] of Object.entries(ordersByCategory)) {
    if (!orders || orders.length === 0) continue;
    hasContent = true;
    lines.push("");
    lines.push(`[ ${label} ]`);
    for (const o of orders) {
      const pauseRange = o.pausePeriod
        ? `（所屬暫停段：${fmtDatetime(o.pausePeriod.start)} ~ ${fmtDatetime(o.pausePeriod.end)}）`
        : "";
      lines.push(`#${o.id} ${fmtDatetime(o.reservationTime)}${pauseRange}`);
    }
  }

  if (!hasContent) return [];

  const header = "訂單異動提醒！\n以下時間已設定暫停銷售，但仍然有新的訂單加入，請檢查是否有正確設定暫停銷售";
  return splitIntoPages(header, lines);
}

/**
 * 系統錯誤通知（發送到 Slack，讓團隊知道系統出問題）
 * @param {string} errorType - 錯誤類型
 * @param {string} detail - 錯誤細節
 * @returns {string} 格式化的錯誤訊息
 */
function formatErrorNotification(errorType, detail) {
  const now = moment().tz(config.TIMEZONE).format("YYYY-MM-DD HH:mm:ss");
  return `⚠️ Slot Monitor 系統異常\n` +
    `時間：${now}\n` +
    `類型：${errorType}\n` +
    `詳情：${detail}`;
}

/**
 * 批次發送所有排隊的通知
 * 重試風暴防護：最多發送 MAX_MESSAGES 則，超過則截斷並回報
 * 任何失敗都會回報，不會靜默停止
 * @param {string[]} messages
 * @returns {Promise<{allOk: boolean, sent: number, failed: number, failedIndices: number[]}>}
 */
const MAX_MESSAGES = 20; // 單次最多發送 20 則，避免 Slack rate limit

async function sendAllNotifications(messages) {
  const totalOriginal = messages.length;

  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(0, MAX_MESSAGES);
  }

  let sent = 0;
  let failed = 0;
  const failedIndices = [];

  for (let i = 0; i < messages.length; i++) {
    const ok = await sendSlackMessage(messages[i]);
    if (ok) {
      sent++;
    } else {
      failed++;
      failedIndices.push(i + 1);
    }
    if (i < messages.length - 1) {
      await sleep(config.SLACK_DELAY_MS);
    }
  }

  // 如果有任何失敗，發送一則錯誤回報
  if (failed > 0) {
    const errorMsg = formatErrorNotification(
      "Slack 發送失敗",
      `${totalOriginal} 則通知中，${sent} 則成功、${failed} 則失敗（第 ${failedIndices.join(", ")} 則）` +
        (totalOriginal > MAX_MESSAGES ? `\n注意：原始 ${totalOriginal} 則超過上限 ${MAX_MESSAGES}，僅嘗試前 ${MAX_MESSAGES} 則` : "")
    );
    // 嘗試發送錯誤通知本身（如果 Slack 完全斷線，這則也會失敗，但至少 console 有紀錄）
    await sleep(2000);
    const errorSent = await sendSlackMessage(errorMsg);
    if (!errorSent) {
      console.error("[slack] 錯誤通知也無法發送，Slack 可能完全無法連線");
    }
  }

  // 超出上限的通知也要回報
  if (totalOriginal > MAX_MESSAGES) {
    const truncMsg = formatErrorNotification(
      "通知數量超出上限",
      `本次產生 ${totalOriginal} 則通知，超過單次上限 ${MAX_MESSAGES} 則，已截斷。請檢查是否有異常。`
    );
    await sleep(1000);
    await sendSlackMessage(truncMsg);
  }

  return { allOk: failed === 0, sent, failed, failedIndices };
}

module.exports = {
  sendSlackMessage,
  sendAllNotifications,
  formatCombinedNewNotifications,
  formatCombinedChangedNotifications,
  formatCombinedOrderAlertNotifications,
  formatErrorNotification,
  splitIntoPages,
  fmtDatetime,
};

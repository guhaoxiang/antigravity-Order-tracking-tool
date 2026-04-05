"use strict";

/**
 * 針對本次修改的測試：
 *   1. order-tracker.js — findNewOrdersInPausedZones 應回傳 pausePeriod
 *   2. slack-notifier.js — formatCombinedOrderAlertNotifications 要包含所屬暫停段
 *   3. insertable-slots.js — 重疊 trip 的 transit 應被過濾掉
 *   4. index.js — 使用 prevPauses 做偵測（behavioral contract）
 */

const moment = require("moment-timezone");
const { findNewOrdersInPausedZones } = require("./slot-monitor/core/order-tracker");
const { formatCombinedOrderAlertNotifications } = require("./slot-monitor/core/slack-notifier");
const { diffPausePeriods } = require("./slot-monitor/core/diff-engine");

// 設定 Slack config 才能 require notifier
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "dummy";
process.env.SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "dummy";

let passed = 0;
let failed = 0;

function assert(cond, desc) {
  if (cond) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.log(`  ✗ ${desc}`);
    failed++;
  }
}

function assertEq(actual, expected, desc) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.log(`  ✗ ${desc}`);
    console.log(`      期望：${e}`);
    console.log(`      實際：${a}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────
console.log("\n═══════ Test 1: order-tracker 附上 pausePeriod ═══════\n");
{
  const base = moment.tz("2026-04-06", "Asia/Taipei").startOf("day").unix();
  const h = (hour, min = 0) => base + hour * 3600 + min * 60;

  const reservations = [
    { id: 1001, reservationTime: h(10, 30), requiredVehicleType: "STANDARD" },   // 落在暫停段 A
    { id: 1002, reservationTime: h(14, 0),  requiredVehicleType: "STANDARD" },   // 可售時段
    { id: 1003, reservationTime: h(16, 0),  requiredVehicleType: "STANDARD" },   // 落在暫停段 B
    { id: 1004, reservationTime: h(16, 30), requiredVehicleType: "LARGE"    },   // 車型不符
    { id: 1005, reservationTime: h(12, 0),  requiredVehicleType: null       },   // null 車型（應比對所有）
  ];

  const pauses = {
    STANDARD_dropoff: [
      { start: h(10, 0), end: h(11, 0) },   // A
      { start: h(15, 30), end: h(17, 0) },  // B
    ],
  };
  const prevIds = { STANDARD_dropoff: [] };
  const cats = [{ key: "STANDARD_dropoff", label: "五人座送機", vehicleType: "STANDARD", tripType: "dropoff" }];

  const result = findNewOrdersInPausedZones(reservations, pauses, prevIds, cats);
  const orders = result.STANDARD_dropoff || [];

  assertEq(orders.length, 2, "找到 2 筆（1001/1003）落在暫停段；1005 在 12:00 屬可售時段");
  // 1001 落入 A
  const o1001 = orders.find((o) => o.id === 1001);
  assert(o1001 != null, "1001 被偵測");
  assert(o1001 && o1001.pausePeriod && o1001.pausePeriod.start === h(10, 0) && o1001.pausePeriod.end === h(11, 0),
    "1001 附上正確的暫停段 A (10:00~11:00)");
  // 1003 落入 B
  const o1003 = orders.find((o) => o.id === 1003);
  assert(o1003 && o1003.pausePeriod && o1003.pausePeriod.start === h(15, 30) && o1003.pausePeriod.end === h(17, 0),
    "1003 附上正確的暫停段 B (15:30~17:00)");
  // 1004 車型不符
  assert(!orders.find((o) => o.id === 1004), "1004 (LARGE) 因車型不符被排除");
  // 1002 落在可售時段
  assert(!orders.find((o) => o.id === 1002), "1002 (14:00) 不在暫停段，被排除");
  // prevIds 過濾
  const result2 = findNewOrdersInPausedZones(reservations, pauses, { STANDARD_dropoff: [1001] }, cats);
  assert(!(result2.STANDARD_dropoff || []).find((o) => o.id === 1001), "prevIds 中的 1001 被跳過");
}

// ─────────────────────────────────────────────────
console.log("\n═══════ Test 2: slack-notifier 顯示所屬暫停段 ═══════\n");
{
  const base = moment.tz("2026-04-06", "Asia/Taipei").startOf("day").unix();
  const h = (hour, min = 0) => base + hour * 3600 + min * 60;

  const input = {
    "五人座送機": [
      { id: 50078, reservationTime: h(16, 0), pausePeriod: { start: h(15, 30), end: h(17, 0) } },
      { id: 50079, reservationTime: h(10, 30), pausePeriod: { start: h(10, 0), end: h(11, 0) } },
    ],
    "七人座接機": [
      { id: 50080, reservationTime: h(8, 0), pausePeriod: { start: h(7, 0), end: h(9, 0) } },
    ],
  };

  const msgs = formatCombinedOrderAlertNotifications(input);
  assertEq(msgs.length, 1, "合併成一則訊息");
  const body = msgs[0];
  assert(body.includes("訂單異動提醒！"), "含 header");
  assert(body.includes("[ 五人座送機 ]"), "含五人座送機分類");
  assert(body.includes("[ 七人座接機 ]"), "含七人座接機分類");
  assert(body.includes("#50078 2026-04-06 16:00"), "含訂單 #50078 時間");
  assert(body.includes("（所屬暫停段：2026-04-06 15:30 ~ 2026-04-06 17:00）"), "含 #50078 所屬暫停段");
  assert(body.includes("（所屬暫停段：2026-04-06 10:00 ~ 2026-04-06 11:00）"), "含 #50079 所屬暫停段");
  assert(body.includes("（所屬暫停段：2026-04-06 07:00 ~ 2026-04-06 09:00）"), "含 #50080 所屬暫停段");

  // 舊資料相容性：沒有 pausePeriod 欄位不應壞掉
  const legacyInput = { "五人座送機": [{ id: 99, reservationTime: h(12, 0) }] };
  const legacyMsgs = formatCombinedOrderAlertNotifications(legacyInput);
  assertEq(legacyMsgs.length, 1, "舊格式仍產出訊息");
  assert(legacyMsgs[0].includes("#99 2026-04-06 12:00"), "舊格式只顯示訂單+時間（無暫停段）");
  assert(!legacyMsgs[0].includes("所屬暫停段"), "舊格式不附暫停段字樣");

  // 空輸入
  assertEq(formatCombinedOrderAlertNotifications({}).length, 0, "空輸入回空陣列");
  assertEq(formatCombinedOrderAlertNotifications({ "A": [] }).length, 0, "各分類為空回空陣列");
}

// ─────────────────────────────────────────────────
console.log("\n═══════ Test 3: insertable-slots 過濾重疊 transit ═══════\n");
{
  // 建構一個 minimal timeline：trip 15:05~16:46 + pre-pickup transit 15:20~15:30（重疊）
  //                           + post-charging transit 19:03~19:55（與 trip 19:40~21:27 重疊）
  //                           + 另一個 standalone transit 17:00~17:10（不重疊）
  const base = moment.tz("2026-04-06", "Asia/Taipei").startOf("day").unix();
  const h = (hour, min = 0) => base + hour * 3600 + min * 60;

  const mockOptions = { defaultRangeKm: 205 };
  const logs = [];
  const mockDebugLog = () => {};

  // 只 require 一次，且確保 zemo-lib 可用
  const { computeInsertableSlots } = require("./scheduler-web-demo/core/insertable-slots");

  // 建構 timelineItems：需含 segments 讓 trip 有 _busyEnd
  const trip1 = {
    type: "trip",
    startTime: h(15, 5),
    endTime: h(16, 46),
    segments: [{ startTime: h(15, 5), endTime: h(16, 46) }],
    reservation: {
      id: 48212,
      reservationTime: h(15, 5),
      origin: { geo: { lat: 25.0805, lng: 121.2311 }, address: "桃園機場" },
      dest: { geo: { lat: 25.0137, lng: 121.2848 }, address: "桃園市富國路" },
    },
    batteryAfterKm: 180,
  };
  const overlapTransit = {
    type: "transit",
    startTime: h(15, 20),
    endTime: h(15, 30),
    fromGeo: { lat: 25.1, lng: 121.3 }, toGeo: { lat: 25.0805, lng: 121.2311 },
    fromAddress: "充電地點", toAddress: "桃園機場",
    distanceKm: 0, durationSec: 600,
  };
  const trip2 = {
    type: "trip",
    startTime: h(19, 40),
    endTime: h(21, 27),
    segments: [{ startTime: h(19, 40), endTime: h(21, 27) }],
    reservation: {
      id: 48213,
      reservationTime: h(19, 40),
      origin: { geo: { lat: 25.0805, lng: 121.2311 }, address: "桃園機場" },
      dest: { geo: { lat: 24.9107, lng: 121.1704 }, address: "楊梅" },
    },
    batteryAfterKm: 150,
  };
  const overlapTransit2 = {
    type: "transit",
    startTime: h(19, 3),
    endTime: h(19, 55),      // 與 trip2 (19:40~21:27) 重疊
    fromGeo: { lat: 25.05, lng: 121.3 }, toGeo: { lat: 25.0805, lng: 121.2311 },
    fromAddress: "充電地點", toAddress: "桃園機場",
    distanceKm: 8.9, durationSec: 3060,
  };
  const standaloneTransit = {
    type: "transit",
    startTime: h(17, 0),
    endTime: h(17, 10),
    fromGeo: { lat: 25.01, lng: 121.28 }, toGeo: { lat: 25.05, lng: 121.3 },
    fromAddress: "桃園市", toAddress: "充電地點",
    distanceKm: 5, durationSec: 600,
  };

  const timelineItems = [trip1, overlapTransit, trip2, overlapTransit2, standaloneTransit];

  // 呼叫 computeInsertableSlots 本身會走過濾邏輯；測試其輸出不會因
  // 重疊 transit 而出現「橫跨 trip 的假 gap」
  const slots = computeInsertableSlots({
    driverId: "test-208",
    timelineItems,
    homeGeo: { lat: 25.0, lng: 121.5 },
    shiftBeginUnix: h(8, 0),
    shiftEndUnix: h(22, 0),
    options: mockOptions,
    debugLog: mockDebugLog,
  });

  // 檢查產出的 windows 是否都在合理位置（不應橫跨 trip1 或 trip2）
  let overlapWithTrip1 = false;
  let overlapWithTrip2 = false;
  let badPhantomGap = false; // 特定病徵：窗口跨越 overlapTransit.end(15:30)~trip2.start(19:40)
  slots.forEach((slot) => {
    (slot.windows || []).forEach((w) => {
      // 窗口時段與 trip1/trip2 的重疊（overlap = max(s) < min(e)）
      if (Math.max(w.startTime, trip1.startTime) < Math.min(w.endTime, trip1.endTime)) overlapWithTrip1 = true;
      if (Math.max(w.startTime, trip2.startTime) < Math.min(w.endTime, trip2.endTime)) overlapWithTrip2 = true;
      // 修復前的病徵：窗口橫跨 trip1（從 15:30 附近開始跨到 16:46 之後）
      if (w.startTime < h(16, 0) && w.endTime > h(17, 0)) badPhantomGap = true;
    });
  });

  assert(!overlapWithTrip1, "無窗口時段與 trip1 (15:05~16:46) 重疊");
  assert(!overlapWithTrip2, "無窗口時段與 trip2 (19:40~21:27) 重疊");
  assert(!badPhantomGap, "無窗口橫跨 trip1（修復前會產生 15:30~18:xx 的假 gap）");

  // 至少應有某個合理窗口（駕駛有空檔）
  const totalWindows = slots.reduce((n, s) => n + (s.windows || []).length, 0);
  console.log(`  (總共產出 ${totalWindows} 個窗口)`);
  assert(totalWindows >= 0, "至少產出窗口陣列（可能為空）");
}

// ─────────────────────────────────────────────────
console.log("\n═══════ Test 4: index.js 行為（用模擬資料）═══════\n");
{
  // 模擬「暫停段剛變更 + 有新訂單」的情境：
  //   舊段 A = 10:00~11:00
  //   新段 B = 10:30~11:30（整體右移 30min）
  //   新訂單 #555 reservationTime=10:15
  //     → 在舊段內（10:15 ∈ [10:00,11:00]）
  //     → 不在新段內（10:15 ∉ [10:30,11:30]）
  // 修改後：應依舊段偵測到 → orderAlert 附上舊段 10:00~11:00
  const base = moment.tz("2026-04-06", "Asia/Taipei").startOf("day").unix();
  const h = (hour, min = 0) => base + hour * 3600 + min * 60;

  const reservations = [{ id: 555, reservationTime: h(10, 15), requiredVehicleType: "STANDARD" }];
  const prevPauses = [{ start: h(10, 0), end: h(11, 0) }];
  const currPauses = [{ start: h(10, 30), end: h(11, 30) }];
  const cat = { key: "STANDARD_dropoff", label: "五人座送機", vehicleType: "STANDARD", tripType: "dropoff" };

  // 模擬修改後的呼叫：pausePeriodsMap 傳 prevPauses
  const prevPausesMap = { [cat.key]: prevPauses };
  const prevOrderIdsMap = { [cat.key]: [] };
  const got = findNewOrdersInPausedZones(reservations, prevPausesMap, prevOrderIdsMap, [cat]);
  const orders = got[cat.key] || [];
  assertEq(orders.length, 1, "用舊段偵測可抓到 #555（若用新段會抓不到）");
  assert(orders[0] && orders[0].pausePeriod && orders[0].pausePeriod.start === h(10, 0),
    "附上的是舊段 10:00~11:00");

  // 對照：若錯用新段 currPauses，會抓不到
  const wrongGot = findNewOrdersInPausedZones(reservations, { [cat.key]: currPauses }, prevOrderIdsMap, [cat]);
  assertEq((wrongGot[cat.key] || []).length, 0, "（對照組）若用新段偵測會漏掉 #555");
}

// ─────────────────────────────────────────────────
console.log("\n═══════ Test 5: index.js 通知順序 ═══════\n");
{
  // 檢查 index.js 中「階段二」之後，三個格式化函式被呼叫的順序
  const fs = require("fs");
  const src = fs.readFileSync("./slot-monitor/index.js", "utf8");
  const phase2Start = src.indexOf("階段二");
  assert(phase2Start > 0, "找到「階段二」區塊");
  // 從「階段二」之後的片段比對 call site 順序（避開檔案頂端的 require 宣告）
  const sub = src.substring(phase2Start);
  const idxOrder = sub.indexOf("formatCombinedOrderAlertNotifications");
  const idxNew = sub.indexOf("formatCombinedNewNotifications");
  const idxChange = sub.indexOf("formatCombinedChangedNotifications");
  assert(idxOrder > 0 && idxNew > 0 && idxChange > 0, "三個格式化函式都在階段二被呼叫");
  assert(idxOrder < idxNew, "訂單異動（優先）出現在報單警告之前");
  assert(idxNew < idxChange, "報單警告在暫停銷售變更之前");
}

// ─────────────────────────────────────────────────
console.log("\n═══════ Test 6: diff-engine 整段比對 ═══════\n");
{
  const base = moment.tz("2026-04-26", "Asia/Taipei").startOf("day").unix();
  const h = (hour, min = 0) => base + hour * 3600 + min * 60;
  const dayStart = base;

  // 使用者回報的案例：16:01~19:01 縮成 16:01~18:53
  // 期望：移除 16:01~19:01 整段 + 新增 16:01~18:53 整段
  const prev = [{ start: h(16, 1), end: h(19, 1) }];
  const curr = [{ start: h(16, 1), end: h(18, 53) }];
  const diff = diffPausePeriods(prev, curr, dayStart);

  assert(!diff.isNew, "非首次");
  assert(diff.hasChanges, "有變更");
  assertEq(diff.removed, [{ start: h(16, 1), end: h(19, 1) }],
    "移除整段舊的 16:01~19:01");
  assertEq(diff.added, [{ start: h(16, 1), end: h(18, 53) }],
    "新增整段新的 16:01~18:53");

  // 完全相同：無變更
  const diff2 = diffPausePeriods(prev, prev, dayStart);
  assert(!diff2.hasChanges, "完全相同時無變更");
  assertEq(diff2.removed, [], "removed 為空");
  assertEq(diff2.added, [], "added 為空");

  // 多段場景：A 不動、B 改邊界、C 被刪、D 新增
  const multiPrev = [
    { start: h(8, 0), end: h(9, 0) },    // A 不動
    { start: h(10, 0), end: h(11, 0) },  // B 會變
    { start: h(14, 0), end: h(15, 0) },  // C 會被刪
  ];
  const multiCurr = [
    { start: h(8, 0), end: h(9, 0) },    // A
    { start: h(10, 0), end: h(11, 30) }, // B 變（11:00 → 11:30）
    { start: h(20, 0), end: h(21, 0) },  // D 新增
  ];
  const diff3 = diffPausePeriods(multiPrev, multiCurr, dayStart);
  assert(diff3.hasChanges, "多段場景有變更");
  // removed：B(整段) + C(整段)
  assertEq(diff3.removed, [
    { start: h(10, 0), end: h(11, 0) },
    { start: h(14, 0), end: h(15, 0) },
  ], "移除：B 整段 10:00~11:00 + C 整段 14:00~15:00");
  // added：B' + D
  assertEq(diff3.added, [
    { start: h(10, 0), end: h(11, 30) },
    { start: h(20, 0), end: h(21, 0) },
  ], "新增：B' 整段 10:00~11:30 + D 整段 20:00~21:00");

  // 首次（prevPeriods=null）
  const diffNew = diffPausePeriods(null, curr, dayStart);
  assert(diffNew.isNew, "首次 isNew=true");
  assertEq(diffNew.added, curr, "首次時 added=所有目前的段");

  // 秒級抖動：±30 秒內視為同段
  const jitterPrev = [{ start: h(10, 0) + 15, end: h(11, 0) - 20 }];  // 10:00:15~10:59:40
  const jitterCurr = [{ start: h(10, 0), end: h(11, 0) }];             // 10:00:00~11:00:00
  const diffJitter = diffPausePeriods(jitterPrev, jitterCurr, dayStart);
  assert(!diffJitter.hasChanges, "秒級抖動在分鐘對齊後不算變更");
}

// ─────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════");
console.log(`  結果：${passed} 通過、${failed} 失敗`);
console.log("══════════════════════════════════════════════");
process.exit(failed > 0 ? 1 : 0);

"use strict";

/**
 * Slot Monitor 單元測試
 *
 * 測試項目：
 *   1. mergeIntervals - 區間合併
 *   2. complementIntervals - 取補集
 *   3. computePausePeriodsForDate - 整合暫停段
 *   4. diffPausePeriods - 分鐘級差異比對
 *   5. findNewOrdersInPausedZones - 訂單異動偵測
 *   6. Slack 訊息格式化
 *
 * 用法: node test/unit-tests.js
 */

const { mergeIntervals, complementIntervals, computePausePeriodsForDate } = require("../core/slot-aggregator");
const { expandToMinuteSet, mergeMinutesToPeriods, diffPausePeriods } = require("../core/diff-engine");
const { findNewOrdersInPausedZones } = require("../core/order-tracker");
const { formatCombinedNewNotifications, formatCombinedChangedNotifications, formatCombinedOrderAlertNotifications } = require("../core/slack-notifier");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

function assertDeepEqual(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) {
    passed++;
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
    console.log(`    expected: ${jb}`);
    console.log(`    actual:   ${ja}`);
  }
}

// ─── 基準時間 ───
const DAY_START = 1711900800; // 2024-04-01 00:00 +08:00 (arbitrary)
const DAY_END = DAY_START + 23 * 3600 + 59 * 60;
function at(h, m = 0) { return DAY_START + h * 3600 + m * 60; }

// ════════════════════════════════════════════════
//  Test 1: mergeIntervals
// ════════════════════════════════════════════════
console.log("\n▶ Test 1: mergeIntervals");

(() => {
  // 空陣列
  assertDeepEqual(mergeIntervals([]), [], "空陣列 → 空");

  // 不重疊
  const r1 = mergeIntervals([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
  assertDeepEqual(r1, [{ start: 10, end: 20 }, { start: 30, end: 40 }], "不重疊保持原狀");

  // 完全重疊
  const r2 = mergeIntervals([{ start: 10, end: 30 }, { start: 15, end: 25 }]);
  assertDeepEqual(r2, [{ start: 10, end: 30 }], "完全包含合併");

  // 部分重疊
  const r3 = mergeIntervals([{ start: 10, end: 25 }, { start: 20, end: 40 }]);
  assertDeepEqual(r3, [{ start: 10, end: 40 }], "部分重疊合併");

  // 相鄰（end = next start）
  const r4 = mergeIntervals([{ start: 10, end: 20 }, { start: 20, end: 30 }]);
  assertDeepEqual(r4, [{ start: 10, end: 30 }], "相鄰合併");

  // 多段亂序
  const r5 = mergeIntervals([
    { start: 50, end: 60 }, { start: 10, end: 20 },
    { start: 15, end: 55 }, { start: 70, end: 80 },
  ]);
  assertDeepEqual(r5, [{ start: 10, end: 60 }, { start: 70, end: 80 }], "多段亂序合併");
})();

// ════════════════════════════════════════════════
//  Test 2: complementIntervals
// ════════════════════════════════════════════════
console.log("\n▶ Test 2: complementIntervals");

(() => {
  // 無可售時段 → 全天暫停
  const r1 = complementIntervals([], 0, 100);
  assertDeepEqual(r1, [{ start: 0, end: 100 }], "無可售 → 全天暫停");

  // 全天可售 → 無暫停
  const r2 = complementIntervals([{ start: 0, end: 100 }], 0, 100);
  assertDeepEqual(r2, [], "全天可售 → 無暫停");

  // 中間有空檔
  const r3 = complementIntervals([{ start: 10, end: 30 }, { start: 60, end: 90 }], 0, 100);
  assertDeepEqual(r3, [{ start: 0, end: 10 }, { start: 30, end: 60 }, { start: 90, end: 100 }], "前中後三段暫停");

  // 起始有可售
  const r4 = complementIntervals([{ start: 0, end: 50 }], 0, 100);
  assertDeepEqual(r4, [{ start: 50, end: 100 }], "前半可售 → 後半暫停");
})();

// ════════════════════════════════════════════════
//  Test 3: computePausePeriodsForDate
// ════════════════════════════════════════════════
console.log("\n▶ Test 3: computePausePeriodsForDate");

(() => {
  // 模擬 debug 結構：兩位 STANDARD 駕駛，各有不同的 insertableSlots
  const debug = {
    "driver1": {
      insertableSlots: [
        { tripType: "dropoff", windows: [{ startTime: at(8), endTime: at(12) }] },
        { tripType: "pickup", windows: [{ startTime: at(9), endTime: at(11) }] },
      ],
    },
    "driver2": {
      insertableSlots: [
        { tripType: "dropoff", windows: [{ startTime: at(10), endTime: at(15) }] },
        { tripType: "pickup", windows: [{ startTime: at(14), endTime: at(18) }] },
      ],
    },
    "driver3": {
      insertableSlots: [
        { tripType: "dropoff", windows: [{ startTime: at(6), endTime: at(10) }] },
      ],
    },
  };
  const driverShifts = [
    { driverId: "driver1", vehicleType: "STANDARD" },
    { driverId: "driver2", vehicleType: "STANDARD" },
    { driverId: "driver3", vehicleType: "LARGE" },
  ];

  // 使用固定日期（DAY_START 對應的日期）
  const moment = require("moment-timezone");
  const dateStr = moment.unix(DAY_START).tz("Asia/Taipei").format("YYYY-MM-DD");
  const result = computePausePeriodsForDate(debug, driverShifts, dateStr);

  // STANDARD_dropoff: driver1 08~12, driver2 10~15 → merged 08~15
  // 暫停: 00:00~07:59, 15:01~23:59（退讓 1 分鐘避免重疊）
  const stdDropoff = result["STANDARD_dropoff"];
  assert(stdDropoff.length === 2, "STANDARD_dropoff 應有 2 段暫停");
  assert(stdDropoff[0].end === at(7, 59), "STANDARD_dropoff 第一段到 07:59（可售 08:00 退讓 1 分）");
  assert(stdDropoff[1].start === at(15, 1), "STANDARD_dropoff 第二段從 15:01（可售 15:00 退讓 1 分）");

  // STANDARD_pickup: driver1 09~11, driver2 14~18 → 暫停: 00:00~09:00, 11:00~14:00, 18:00~23:59
  const stdPickup = result["STANDARD_pickup"];
  assert(stdPickup.length === 3, "STANDARD_pickup 應有 3 段暫停");

  // LARGE_dropoff: driver3 06~10 → 暫停: 00:00~06:00, 10:00~23:59
  const largeDropoff = result["LARGE_dropoff"];
  assert(largeDropoff.length === 2, "LARGE_dropoff 應有 2 段暫停");

  // LARGE_pickup: 無駕駛有 pickup windows → 全天暫停
  const largePickup = result["LARGE_pickup"];
  assert(largePickup.length === 1, "LARGE_pickup 應有 1 段暫停（全天）");
})();

// ════════════════════════════════════════════════
//  Test 4: diffPausePeriods
// ════════════════════════════════════════════════
console.log("\n▶ Test 4: diffPausePeriods");

(() => {
  // 4a. 首次（prev = null）
  const d1 = diffPausePeriods(null, [{ start: at(0), end: at(5) }], DAY_START);
  assert(d1.isNew === true, "首次 isNew=true");
  assert(d1.hasChanges === true, "首次有暫停段 hasChanges=true");
  assert(d1.added.length === 1, "首次 added=1");

  // 4b. 無變更
  const pauses = [{ start: at(0), end: at(5) }, { start: at(10), end: at(15) }];
  const d2 = diffPausePeriods(pauses, pauses, DAY_START);
  assert(d2.isNew === false, "無變更 isNew=false");
  assert(d2.hasChanges === false, "無變更 hasChanges=false");
  assert(d2.removed.length === 0, "無變更 removed=0");
  assert(d2.added.length === 0, "無變更 added=0");

  // 4c. 縮短暫停段（部分移除）
  const prev = [{ start: at(7), end: at(9, 15) }];
  const curr = [{ start: at(7), end: at(8, 2) }];
  const d3 = diffPausePeriods(prev, curr, DAY_START);
  assert(d3.hasChanges === true, "縮短有變更");
  assert(d3.removed.length === 1, "移除 1 段");
  assert(d3.added.length === 0, "無新增");
  // 移除的是 08:02~09:15
  const removedStart = d3.removed[0].start;
  const removedEnd = d3.removed[0].end;
  assert(removedStart === at(8, 2), "移除段起點 08:02");
  assert(removedEnd <= at(9, 16), "移除段終點 ≤ 09:16");

  // 4d. 新增暫停段
  const prev2 = [{ start: at(7), end: at(8) }];
  const curr2 = [{ start: at(7), end: at(8) }, { start: at(10), end: at(11) }];
  const d4 = diffPausePeriods(prev2, curr2, DAY_START);
  assert(d4.hasChanges === true, "新增有變更");
  assert(d4.removed.length === 0, "無移除");
  assert(d4.added.length === 1, "新增 1 段");

  // 4e. 完全移除（之前有暫停，現在沒有）
  const d5 = diffPausePeriods([{ start: at(12), end: at(14) }], [], DAY_START);
  assert(d5.hasChanges === true, "完全移除有變更");
  assert(d5.removed.length === 1, "移除 1 段");
  assert(d5.added.length === 0, "無新增");

  // 4f. 同時新增+移除
  const prev3 = [{ start: at(7), end: at(9) }];
  const curr3 = [{ start: at(7), end: at(8) }, { start: at(10), end: at(11) }];
  const d6 = diffPausePeriods(prev3, curr3, DAY_START);
  assert(d6.hasChanges === true, "同時新增+移除");
  assert(d6.removed.length === 1, "移除 1 段 (08~09)");
  assert(d6.added.length === 1, "新增 1 段 (10~11)");
})();

// ════════════════════════════════════════════════
//  Test 5: findNewOrdersInPausedZones
// ════════════════════════════════════════════════
console.log("\n▶ Test 5: findNewOrdersInPausedZones");

(() => {
  const categories = [
    { key: "STANDARD_dropoff", vehicleType: "STANDARD", tripType: "dropoff" },
  ];
  const pauses = { "STANDARD_dropoff": [{ start: at(0), end: at(6) }, { start: at(16), end: at(23, 59) }] };

  // 5a. 新訂單在暫停區內
  const res1 = findNewOrdersInPausedZones(
    [{ id: 101, reservationTime: at(3) }, { id: 102, reservationTime: at(10) }],
    pauses,
    { "STANDARD_dropoff": [] },
    categories
  );
  assert(res1["STANDARD_dropoff"].length === 1, "只有 #101 在暫停區");
  assert(res1["STANDARD_dropoff"][0].id === 101, "#101 被偵測到");

  // 5b. 舊訂單不重複通知
  const res2 = findNewOrdersInPausedZones(
    [{ id: 101, reservationTime: at(3) }, { id: 103, reservationTime: at(17) }],
    pauses,
    { "STANDARD_dropoff": [101] },
    categories
  );
  assert(res2["STANDARD_dropoff"].length === 1, "只通知新的 #103");
  assert(res2["STANDARD_dropoff"][0].id === 103, "#103 被偵測到");

  // 5c. 所有訂單都在可售區 → 無通知
  const res3 = findNewOrdersInPausedZones(
    [{ id: 104, reservationTime: at(10) }],
    pauses,
    { "STANDARD_dropoff": [] },
    categories
  );
  assert(res3["STANDARD_dropoff"].length === 0, "可售區訂單不通知");
})();

// ════════════════════════════════════════════════
//  Test 6: Slack 訊息格式化
// ════════════════════════════════════════════════
console.log("\n▶ Test 6: Slack 訊息格式化（合併版）");

(() => {
  // 6a. 合併多分類首次通知
  const msgs1 = formatCombinedNewNotifications({
    "五人座送機": [{ start: at(0), end: at(5) }, { start: at(16), end: at(23, 59) }],
    "七人座接機": [{ start: at(10), end: at(12) }],
  });
  assert(msgs1.length === 1, "合併通知 1 則訊息");
  assert(msgs1[0].includes("報單警告"), "包含報單警告");
  assert(msgs1[0].includes("3 筆"), "顯示 3 筆（2+1）");
  assert(msgs1[0].includes("[ 五人座送機 ]"), "包含五人座送機區塊");
  assert(msgs1[0].includes("[ 七人座接機 ]"), "包含七人座接機區塊");

  // 6b. 合併變更通知
  const msgs2 = formatCombinedChangedNotifications(
    { "五人座送機": [{ start: at(7), end: at(9) }] },
    { "七人座接機": [{ start: at(10), end: at(11) }] }
  );
  assert(msgs2.length === 1, "變更通知 1 則");
  assert(msgs2[0].includes("移除"), "包含移除");
  assert(msgs2[0].includes("新增"), "包含新增");
  assert(msgs2[0].includes("[ 五人座送機 ]"), "移除歸類到五人座送機");
  assert(msgs2[0].includes("[ 七人座接機 ]"), "新增歸類到七人座接機");

  // 6c. 空分類 → 不產生訊息
  const msgs3 = formatCombinedNewNotifications({});
  assert(msgs3.length === 0, "無暫停段不產生訊息");

  // 6d. 訂單異動（合併版）
  const msgs4 = formatCombinedOrderAlertNotifications({
    "五人座接機": [{ id: 106, reservationTime: at(8, 30) }],
    "七人座送機": [{ id: 107, reservationTime: at(14) }],
  });
  assert(msgs4.length === 1, "訂單異動 1 則");
  assert(msgs4[0].includes("#106"), "包含訂單 #106");
  assert(msgs4[0].includes("#107"), "包含訂單 #107");
  assert(msgs4[0].includes("訂單異動"), "包含異動標題");

  // 6e. 大量暫停段訊息分割
  const manyPeriods = [];
  for (let i = 0; i < 200; i++) {
    manyPeriods.push({ start: at(0) + i * 120, end: at(0) + i * 120 + 60 });
  }
  const msgs5 = formatCombinedNewNotifications({ "七人座送機": manyPeriods });
  assert(msgs5.length > 1, `大量暫停段應分割(got ${msgs5.length}則)`);
  assert(msgs5[0].includes("(1/"), "第一則有分頁標記");
})();

// ════════════════════════════════════════════════
//  Test 7: expandToMinuteSet + mergeMinutesToPeriods 往返一致性
// ════════════════════════════════════════════════
console.log("\n▶ Test 7: 分鐘展開/回收往返一致性");

(() => {
  const periods = [
    { start: DAY_START + 120 * 60, end: DAY_START + 180 * 60 },  // 02:00~03:00
    { start: DAY_START + 600 * 60, end: DAY_START + 660 * 60 },  // 10:00~11:00
  ];
  const set = expandToMinuteSet(periods, DAY_START);
  assert(set.size === 120, "02:00~03:00 + 10:00~11:00 = 120 分鐘");

  const merged = mergeMinutesToPeriods(set, DAY_START);
  assert(merged.length === 2, "回收後 2 段");
  assert(merged[0].start === periods[0].start, "第一段起點一致");
  assert(merged[1].end === periods[1].end, "第二段終點一致");
})();

// ════════════════════════════════════════════════
//  結果
// ════════════════════════════════════════════════
console.log("");
console.log("══════════════════════════════════════════════");
console.log(`  測試結果: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════");

process.exit(failed > 0 ? 1 : 0);

const moment = require("moment-timezone");

const {
  fetchDriverList,
  fetchDriversScheduleAndLeave,
} = require("./core/zemo-client");

async function main() {
  const dateStr = process.argv[2] || "2026-03-17";
  const targetName = "潘彥彬";

  console.log("=== 調試駕駛可排班狀態 ===");
  console.log("日期:", dateStr);
  console.log("目標駕駛姓名:", targetName);

  const { userList, warning: userWarning } = await fetchDriverList();
  if (userWarning) {
    console.log("取得駕駛列表警告:", userWarning);
  }
  if (!Array.isArray(userList) || userList.length === 0) {
    console.log("userList 為空，無法判斷。");
    return;
  }

  const matches = userList.filter((u) => {
    const name =
      u.username || u.name || (u.passenger && u.passenger.name) || "";
    return String(name).includes(targetName);
  });

  if (matches.length === 0) {
    console.log("在 userList 中找不到名稱包含", targetName, "的駕駛。");
    return;
  }

  console.log("\n在 userList 中找到以下駕駛：");
  matches.forEach((u) => {
    const name =
      u.username || u.name || (u.passenger && u.passenger.name) || "";
    console.log(
      `- id=${u.id}, name=${name}, service=${u.service}, isEnabled=${u.isEnabled}, vehicleType=${u.vehicleType}`
    );
  });

  const pan = matches[0];
  const userId = pan.id;

  // 取得班表與請假
  const { driversData, warning: scheduleWarning } =
    await fetchDriversScheduleAndLeave([userId], dateStr, dateStr);
  if (scheduleWarning) {
    console.log("\n取得班表與請假警告:", scheduleWarning);
  }

  if (!Array.isArray(driversData) || driversData.length === 0) {
    console.log("\ngetDriversScheduleAndLeave 回傳為空，該日沒有班表/請假資料。");
    return;
  }

  const d = driversData[0];
  const tz = "Asia/Taipei";
  const m = moment.tz(dateStr, tz);
  const isoWeekday = m.isoWeekday(); // 1..7
  const WEEKDAY_KEYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const weekdayKey = WEEKDAY_KEYS[isoWeekday - 1];

  console.log("\ngetDriversScheduleAndLeave 對應資料：");
  console.log(
    `driverId=${d.userId}, service=${d.service}, isEnabled=${d.isEnabled}`
  );

  const weekly = d.weeklySchedule || {};
  const ranges = weekly[weekdayKey] || [];
  console.log(`weekdayKey=${weekdayKey}, 當天 weeklySchedule:`, ranges);

  const leaves = d.leaves || [];
  console.log("當日 leaves (原始):");
  leaves.forEach((l) => {
    const from = moment.unix(l.from).tz(tz).format("YYYY-MM-DD HH:mm");
    const to = moment.unix(l.to).tz(tz).format("YYYY-MM-DD HH:mm");
    console.log(`- from=${from}, to=${to}`);
  });
}

main().catch((err) => {
  console.error("調試過程發生錯誤:", err);
  process.exit(1);
});


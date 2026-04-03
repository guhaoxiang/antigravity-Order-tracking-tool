const fs = require("fs");
const path = require("path");
const axios = require("axios");
const moment = require("moment-timezone");

const { reduceDriverSchedulesWithLeaves } = require("../zemo-lib/libs/driver");

const CONFIG_PATH = path.join(__dirname, "..", "config", "zemo-api.json");
const TAIPEI = "Asia/Taipei";

// 行程狀態（與你提供的代號對應，用於取得排程相關訂單）
const RESERVATION_STATUS = {
  WAITING: 1,
  FINISHED: 2,
  CANCEL: 3,
  IN_PROGRESS: 4,
  BOOKED: 5,
  UNASSIGNED: 6,
  BOOKED_CANCELLED: 7,
  UNASSIGNED_CANCELLED: 8,
  WAITING_TIMEOUT: 9,
  OUTSOURCED: 10,
  REJECTED: 11,
  EMPTY_TRIP: 12,
  PENDING_SCHEDULE: 13,
};

/** 排程時要撈的狀態：已訂、進行中、待排程、未指派、外派等 */
const SCHEDULING_STATUSES = [
  RESERVATION_STATUS.FINISHED,
  RESERVATION_STATUS.IN_PROGRESS,
  RESERVATION_STATUS.BOOKED,
  RESERVATION_STATUS.UNASSIGNED,
  RESERVATION_STATUS.OUTSOURCED,
  RESERVATION_STATUS.PENDING_SCHEDULE,
];

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return loadConfig.defaults();
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return { ...loadConfig.defaults(), ...JSON.parse(raw) };
}
loadConfig.defaults = () => ({
  baseUrl: process.env.ZEMO_API_BASE_URL || "https://www.zemotw.com",
  reservationEndpoint: "/api/reservation/records",
  userListEndpoint: "/api/user/getUserList",
  scheduleAndLeaveEndpoint: "/api/driver/getDriversScheduleAndLeave",
  authHeaderName: "Authorization",
  authHeaderValue: "",
  timezone: TAIPEI,
  lineId: process.env.ZEMO_LINE_ID || "",
});

const WEEKDAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** "HH:mm" -> { hour, minute } */
function parseTimeHHmm(str) {
  if (!str || typeof str !== "string") return { hour: 0, minute: 0 };
  const [h, m] = str.trim().split(":").map(Number);
  return { hour: isNaN(h) ? 0 : h, minute: isNaN(m) ? 0 : m };
}

function isActiveDriverLike(obj) {
  if (!obj) return false;
  // service: 1 / true => 啟用；0 / false / null => 停用
  const serviceOk = obj.service === true || obj.service === 1 || obj.service === "1";
  const enabledOk = obj.isEnabled !== false;
  return serviceOk && enabledOk;
}

/**
 * 將 getUserList 回傳的 userList 轉成指定日期當天的 driverShifts（演算法格式）
 * @param {Array} userList - getUserList 的 userList
 * @param {string} dateStr - 日期 YYYY-MM-DD
 * @param {string} timezone
 * @returns {Array} driverShifts
 */
function mapUserListToDriverShiftsForDate(userList, dateStr, timezone = TAIPEI) {
  if (!Array.isArray(userList) || userList.length === 0) return [];
  const date = moment.tz(dateStr, timezone);
  const isoWeekday = date.isoWeekday(); // 1=Monday .. 7=Sunday
  const key = WEEKDAY_KEYS[isoWeekday - 1] + "TimeRanges";
  const out = [];
  for (const user of userList) {
    // 僅排入「目前可使用」的駕駛
    if (!isActiveDriverLike(user)) continue;
    const ranges = user[key];
    if (!Array.isArray(ranges) || ranges.length === 0) continue;
    const homeLocation = user.homeLocation || null;
    // 支援同一天多個 time range（例如 00:00~06:59 與 19:00~23:59）
    for (const r of ranges) {
      const start = parseTimeHHmm(r.start);
      const end = parseTimeHHmm(r.end);
      out.push({
        driverId: user.id,
        driver: {
          user_id: user.id,
          vehicle_type: user.vehicleType || "STANDARD",
        },
        isoWeekday,
        shift: {
          shiftBeginTime: { isoWeekday, hour: start.hour, minute: start.minute },
          shiftEndTime: { isoWeekday, hour: end.hour, minute: end.minute },
        },
        vehicleType: user.vehicleType || "STANDARD",
        homeLocation: homeLocation
          ? {
              geo: homeLocation.geo || { lat: 0, lng: 0 },
              address: homeLocation.address || "",
            }
          : null,
      });
    }
  }
  return out;
}

/**
 * 取得駕駛班表與請假（POST /api/driver/getDriversScheduleAndLeave）
 * @param {number[]} userIds
 * @param {string} fromDateStr - YYYY-MM-DD
 * @param {string} toDateStr - YYYY-MM-DD
 * @returns {Promise<{ driversData: Array, warning?: string }>}
 */
async function fetchDriversScheduleAndLeave(userIds, fromDateStr, toDateStr) {
  const config = loadConfig();
  const endpoint = config.scheduleAndLeaveEndpoint || "/api/driver/getDriversScheduleAndLeave";
  const body = { userIds, from: fromDateStr, to: toDateStr };
  if (config.lineId) body.lineId = config.lineId;

  const headers = { "Content-Type": "application/json" };
  if (config.authHeaderName && config.authHeaderValue) {
    headers[config.authHeaderName] = config.authHeaderValue;
  }

  const url = config.baseUrl.replace(/\/$/, "") + endpoint;
  try {
    const res = await axios.post(url, body, { headers, timeout: 15000 });

    if (!res.data || res.data.success !== true) {
      return {
        driversData: [],
        warning: `取得駕駛班表與請假失敗（${url}，success != true）`,
      };
    }
    return { driversData: res.data.driversData || [], warning: null };
  } catch (err) {
    const status = err.response?.status;
    const msg = status
      ? `取得駕駛班表與請假失敗（HTTP ${status}，URL: ${url}）`
      : `取得駕駛班表與請假失敗（${err.message || err}）`;
    return { driversData: [], warning: msg };
  }
}

/**
 * 由 getDriversScheduleAndLeave 的 driversData + 駕駛列表 userList，產出該日扣除請假後的 driverShifts
 * 使用 zemo-api 的 reduceDriverSchedulesWithLeaves 與原本排程架構一致
 * @param {Array} driversData - getDriversScheduleAndLeave 回傳的 driversData
 * @param {Array} userList - getUserList 回傳的 userList（供 homeLocation、vehicleType）
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} timezone
 * @returns {Array} driverShifts
 */
function buildDriverShiftsFromScheduleAndLeave(driversData, userList, dateStr, timezone = TAIPEI) {
  if (!Array.isArray(driversData) || driversData.length === 0) return [];
  const date = moment.tz(dateStr, timezone);
  const isoWeekday = date.isoWeekday();
  const weekdayKey = WEEKDAY_KEYS[isoWeekday - 1];
  const userById = new Map((userList || []).map((u) => [u.id, u]));

  const baseSchedules = [];
  const allLeaves = [];

  for (const d of driversData) {
    const userId = d.userId;
    const user = userById.get(userId);
    // 僅保留「目前可使用」的駕駛（離職或停用者不排入）
    if (!isActiveDriverLike(d)) continue;
    if (user && !isActiveDriverLike(user)) continue;
    const vehicleType = (user && user.vehicleType) || "STANDARD";
    const homeLocation = user && user.homeLocation ? {
      geo: user.homeLocation.geo || { lat: 0, lng: 0 },
      address: user.homeLocation.address || "",
    } : null;

    const weekly = d.weeklySchedule || {};
    const ranges = weekly[weekdayKey];
    if (!Array.isArray(ranges) || ranges.length === 0) continue;

    // 支援同一天多個 time range（例如 00:00~06:59 與 19:00~23:59）
    for (const r of ranges) {
      const start = parseTimeHHmm(r.start);
      const end = parseTimeHHmm(r.end);

      baseSchedules.push({
        driverId: userId,
        driver: { user_id: userId, vehicle_type: vehicleType },
        isoWeekday,
        shift: {
          shiftBeginTime: { isoWeekday, hour: start.hour, minute: start.minute },
          shiftEndTime: { isoWeekday, hour: end.hour, minute: end.minute },
        },
        vehicleType,
        homeLocation,
      });
    }

    const leaves = d.leaves || [];
    for (const l of leaves) {
      allLeaves.push({ driverId: userId, from: l.from, to: l.to });
    }
  }

  return reduceDriverSchedulesWithLeaves(baseSchedules, allLeaves);
}

/**
 * 取得駕駛列表（POST /api/user/getUserList, userType: 2）
 * @returns {Promise<{ userList: Array, warning?: string }>}
 */
async function fetchDriverList() {
  const config = loadConfig();
  const endpoint = config.userListEndpoint || "/api/user/getUserList";
  // 以你提供的成功範例為準，欄位名稱為 userType
  const body = { userType: 2 };
  if (config.lineId) body.lineId = config.lineId;

  const headers = { "Content-Type": "application/json" };
  if (config.authHeaderName && config.authHeaderValue) {
    headers[config.authHeaderName] = config.authHeaderValue;
  }

  const url = config.baseUrl.replace(/\/$/, "") + endpoint;
  try {
    const res = await axios.post(url, body, { headers, timeout: 15000 });

    if (!res.data || res.data.success !== true) {
      return {
        userList: [],
        warning: `取得駕駛列表失敗（${url}，success != true）`,
      };
    }
    return { userList: res.data.userList || [], warning: null };
  } catch (err) {
    const status = err.response?.status;
    const msg = status
      ? `取得駕駛列表失敗（HTTP ${status}，URL: ${url}）`
      : `取得駕駛列表失敗（${err.message || err}）`;
    return { userList: [], warning: msg };
  }
}

/**
 * 將 API 回傳的一筆 reservation 轉成排程演算法需要的格式
 * @param {Object} record - reservation/records 回傳的單筆
 * @returns {Object} - { id, reservationTime, origin, dest, passenger, enterpriseId, requiredVehicleType, moreStops }
 */
function mapRecordToReservation(record) {
  const lat = (geo) => (geo && (geo.lat ?? geo.latitude)) || 0;
  const lng = (geo) => (geo && (geo.lng ?? geo.lon ?? geo.longitude)) || 0;
  const origin = record.origin || {};
  const dest = record.dest || {};

  const passengerUser = record.passengerUser || {};
  const passengerCore = (passengerUser && passengerUser.passenger) || record.passenger || {};
  const enterpriseObj = passengerCore.enterprise || {};

  return {
    id: record.id,
    reservationTime: record.reservationTime,
    origin: {
      geo: { lat: lat(origin.geo), lng: lng(origin.geo) },
      address: origin.address || "",
    },
    dest: {
      geo: { lat: lat(dest.geo), lng: lng(dest.geo) },
      address: dest.address || "",
    },
    passenger: {
      name: passengerUser.username || passengerCore.name || null,
      enterpriseName: enterpriseObj.name || passengerCore.enterpriseName || null,
    },
    enterpriseId:
      enterpriseObj.id ||
      passengerCore.enterpriseId ||
      (record.passenger && record.passenger.enterpriseId) ||
      null,
    requiredVehicleType: record.requiredVehicleType || null,
    moreStops: record.moreStops || [],
  };
}

/**
 * 取得指定日期的預約列表（POST /api/reservation/records）
 * @param {string} dateStr - 日期 YYYY-MM-DD
 * @param {Object} options - { lineId?, reservationStatus?, enterpriseIds? }
 * @returns {Promise<{ reservations: Array, warning?: string }>}
 */
async function fetchReservationsForDate(dateStr, options = {}) {
  const config = loadConfig();
  const date = moment.tz(dateStr, config.timezone || TAIPEI);
  const from = date.clone().startOf("day").unix();
  const to = date.clone().endOf("day").unix();

  const body = {
    from,
    to,
    reservationStatus: options.reservationStatus || SCHEDULING_STATUSES,
    enterpriseIds: options.enterpriseIds || [],
  };
  if (options.lineId != null && options.lineId !== "") body.lineId = options.lineId;
  if (config.lineId) body.lineId = config.lineId;

  const headers = { "Content-Type": "application/json" };
  if (config.authHeaderName && config.authHeaderValue) {
    headers[config.authHeaderName] = config.authHeaderValue;
  }

  const url = config.baseUrl.replace(/\/$/, "") + config.reservationEndpoint;
  try {
    const res = await axios.post(url, body, { headers, timeout: 15000 });

    if (!res.data || res.data.success !== true) {
      return {
        reservations: [],
        warning: `呼叫預約 API 失敗（${url}，success != true）`,
      };
    }

    const records = res.data.reservationRecords || [];
    const reservations = records.map(mapRecordToReservation);
    return { reservations, warning: null };
  } catch (err) {
    const status = err.response?.status;
    const msg = status
      ? `呼叫預約 API 失敗（HTTP ${status}，URL: ${url}）`
      : `呼叫預約 API 失敗（${err.message || err}）`;
    return { reservations: [], warning: msg };
  }
}

/**
 * 取得指定日期的預約 + 司機班表（駕駛資訊尚未提供時，driverShifts 為空）
 * @param {string} dateStr - 日期 YYYY-MM-DD
 * @returns {Promise<{ reservations: Array, driverShifts: Array, warning?: string }>}
 */
async function fetchReservationsAndShifts(dateStr) {
  const config = loadConfig();

  if (!config.baseUrl || !config.reservationEndpoint) {
    return {
      reservations: [],
      driverShifts: [],
      warning: "尚未設定 ZEMO API（config/zemo-api.json）的 baseUrl 與 reservationEndpoint。",
    };
  }

  const { reservations, warning: fetchWarning } = await fetchReservationsForDate(dateStr);
  let driverShifts = [];
  let userList = [];
  let warning = fetchWarning || null;

  const userListEndpoint = config.userListEndpoint || "/api/user/getUserList";
  const scheduleAndLeaveEndpoint = config.scheduleAndLeaveEndpoint || "/api/driver/getDriversScheduleAndLeave";
  if (config.baseUrl && userListEndpoint) {
    const driverListResult = await fetchDriverList();
    userList = driverListResult.userList || [];
    const driverWarning = driverListResult.warning;
    if (driverWarning) {
      warning = warning ? warning + " " + driverWarning : driverWarning;
    } else if (userList.length > 0 && scheduleAndLeaveEndpoint) {
      const userIds = userList.map((u) => u.id);
      const { driversData, warning: scheduleWarning } = await fetchDriversScheduleAndLeave(userIds, dateStr, dateStr);
      if (scheduleWarning) {
        warning = warning ? warning + " " + scheduleWarning : scheduleWarning;
        driverShifts = mapUserListToDriverShiftsForDate(userList, dateStr, config.timezone || TAIPEI);
      } else {
        driverShifts = buildDriverShiftsFromScheduleAndLeave(driversData, userList, dateStr, config.timezone || TAIPEI);
      }
    } else {
      driverShifts = mapUserListToDriverShiftsForDate(userList, dateStr, config.timezone || TAIPEI);
    }
  } else {
    warning = warning
      ? warning + " 未設定 userListEndpoint，目前無法取得駕駛班表。"
      : "未設定 userListEndpoint，driverShifts 為空。";
  }

  return {
    reservations,
    driverShifts,
    driverMeta: userList,
    warning,
  };
}

/**
 * 批次版：預先載入駕駛列表 + 指定日期範圍的班表與請假，供多日排程重用。
 * @param {string} fromDateStr - 起始日期 YYYY-MM-DD
 * @param {string} toDateStr   - 結束日期 YYYY-MM-DD
 * @returns {Promise<{ userList, driversData, warning }>}
 */
async function prefetchDriverData(fromDateStr, toDateStr) {
  const { userList, warning: driverWarning } = await fetchDriverList();
  if (driverWarning || userList.length === 0) {
    return { userList: userList || [], driversData: [], warning: driverWarning || null };
  }
  const userIds = userList.map((u) => u.id);
  const { driversData, warning: scheduleWarning } = await fetchDriversScheduleAndLeave(userIds, fromDateStr, toDateStr);
  return { userList, driversData: driversData || [], warning: scheduleWarning || null };
}

/**
 * 用預取的駕駛資料，取得指定日期的預約 + 班表（只需 1 次 API 呼叫取預約）
 * @param {string} dateStr
 * @param {{ userList, driversData }} prefetched
 * @returns {Promise<{ reservations, driverShifts, driverMeta, warning }>}
 */
async function fetchReservationsWithPrefetchedDrivers(dateStr, prefetched) {
  const config = loadConfig();
  const { reservations, warning: fetchWarning } = await fetchReservationsForDate(dateStr);
  let driverShifts = [];
  const { userList, driversData } = prefetched;

  if (driversData && driversData.length > 0) {
    // 過濾 leaves 只保留與 dateStr 重疊的（避免跨日期範圍的 leaves 影響當天班表）
    const dayStart = moment.tz(dateStr, config.timezone || TAIPEI).startOf("day").unix();
    const dayEnd = moment.tz(dateStr, config.timezone || TAIPEI).endOf("day").unix();
    const filteredDriversData = driversData.map((d) => ({
      ...d,
      leaves: (d.leaves || []).filter((l) => l.from <= dayEnd && l.to >= dayStart),
    }));
    driverShifts = buildDriverShiftsFromScheduleAndLeave(filteredDriversData, userList, dateStr, config.timezone || TAIPEI);
  } else if (userList && userList.length > 0) {
    driverShifts = mapUserListToDriverShiftsForDate(userList, dateStr, config.timezone || TAIPEI);
  }

  return {
    reservations,
    driverShifts,
    driverMeta: userList || [],
    warning: fetchWarning || null,
  };
}

module.exports = {
  fetchReservationsForDate,
  fetchReservationsAndShifts,
  fetchDriverList,
  fetchDriversScheduleAndLeave,
  prefetchDriverData,
  fetchReservationsWithPrefetchedDrivers,
  mapRecordToReservation,
  mapUserListToDriverShiftsForDate,
  buildDriverShiftsFromScheduleAndLeave,
  RESERVATION_STATUS,
  SCHEDULING_STATUSES,
};

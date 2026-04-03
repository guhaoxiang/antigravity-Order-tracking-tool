// Baseline configuration snapshot copied from zemo-api/libs/environment.js
// This represents the \"原始\" 演算法環境，用來做差異報告與重設。

const defaultSpeedBands = [
  { maxDist: 3, speed: 11.5 },
  { maxDist: 10, speed: 13 },
  { maxDist: 15, speed: 21.5 },
  { maxDist: 20, speed: 25.5 },
  { maxDist: 30, speed: 37 },
  { maxDist: 60, speed: 47 },
  { maxDist: 80, speed: 58 },
  { maxDist: Infinity, speed: 62 },
];

const baselineEnv = {
  estimatedSpeedKmh: 15,
  estimatedAirportSpeedKmh: 30,
  estimatedLightHourAirportSpeedKmh: 45,
  estimatedDelaySeconds: 300,
  betweenReservationBufferSeconds: 300,
  defaultRangeKm: 205,
  minimumIdleTimeToChargeSeconds: 20 * 60,
  estimatedTimeToFindChargingStationSeconds: 20 * 60,
  enableDriverLoadBalancing: true,
  enableVehicleTypeRouting: true,
  enableGapFilling: true,
  enableGapFillingBatteryValidation: true,
  enablePriorityBasedScheduling: true,
  enablePriorityBasedEligibilityCheck: true,
  maxRangeForFirstReservationKm: 15,
  firstReservationBufferSeconds: 50 * 60,
  sortLowPriorityReservationsByTime: false,
  geoRushHourMinutes: 10,
  geoLightHourMinutes: -5,
  // 尖峰時段範圍（HH:MM 字串）
  rushHourMorningStart: "06:00",
  rushHourMorningEnd: "10:00",
  rushHourEveningStart: "15:00",
  rushHourEveningEnd: "20:00",
  // 離峰時段範圍（HH:MM 字串）
  lightHourEarlyEnd: "06:30",
  lightHourLateStart: "20:00",
  geoEstimatedSpeedBands: JSON.stringify(defaultSpeedBands, null, 2),
  // 企業優先度：高優先企業 ID 清單（逗號分隔字串，供 UI 顯示），可在 settings 頁面覆寫
  highPriorityEnterpriseIdsCsv: "",
  // 企業優先度：低優先企業 ID 清單（逗號分隔，對應 LOW_PRIORITY_ENTERPRISES）
  lowPriorityEnterpriseIdsCsv: "41,42,43,37",
  // 司機優先層級：Relief / Secondary 司機 ID 清單（逗號分隔，對應 RELIEF_DRIVER_IDS / SECONDARY_DRIVER_IDS）
  reliefDriverIdsCsv: "218,219,133,11,274,275",
  secondaryDriverIdsCsv: "282",
};

function getBaselineConfig() {
  return { ...baselineEnv };
}

module.exports = {
  baselineEnv,
  getBaselineConfig,
};


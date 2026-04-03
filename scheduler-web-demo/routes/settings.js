const express = require("express");
const router = express.Router();

const { getConfig, updateConfig, resetToBaseline } = require("../core/env-config");

router.get("/", (req, res) => {
  res.render("settings", {
    config: getConfig(),
    message: null,
  });
});

router.post("/", (req, res) => {
  const body = req.body || {};

  if (body.action === "reset") {
    resetToBaseline();
    return res.render("settings", {
      config: getConfig(),
      message: "已重設為 zemo-api 預設參數。",
    });
  }

  const numericFields = [
    "estimatedSpeedKmh",
    "estimatedAirportSpeedKmh",
    "estimatedLightHourAirportSpeedKmh",
    "estimatedDelaySeconds",
    "betweenReservationBufferSeconds",
    "defaultRangeKm",
    "minimumIdleTimeToChargeSeconds",
    "estimatedTimeToFindChargingStationSeconds",
    "firstReservationBufferSeconds",
    "maxRangeForFirstReservationKm",
    "geoRushHourMinutes",
    "geoLightHourMinutes",
  ];

  const booleanFields = [
    "enableDriverLoadBalancing",
    "enableVehicleTypeRouting",
    "enableGapFilling",
    "enableGapFillingBatteryValidation",
    "enablePriorityBasedScheduling",
    "enablePriorityBasedEligibilityCheck",
    "enableCheckIfReservationAllowed",
    "sortLowPriorityReservationsByTime",
    "checkBatteryRange",
  ];

  const updates = {};

  numericFields.forEach((field) => {
    if (body[field] !== undefined && body[field] !== "") {
      const n = Number(body[field]);
      if (!Number.isNaN(n)) {
        updates[field] = n;
      }
    }
  });

  // 解析時速分段欄位 speedBandMaxDist_i / speedBandSpeed_i
  const speedBands = [];
  const maxRows = 8;
  for (let i = 1; i <= maxRows; i++) {
    const maxDistRaw = body[`speedBandMaxDist_${i}`];
    const speedRaw = body[`speedBandSpeed_${i}`];
    if (speedRaw === undefined || speedRaw === "") continue;
    const speed = Number(speedRaw);
    if (Number.isNaN(speed)) continue;
    let maxDist = null;
    if (maxDistRaw !== undefined && maxDistRaw !== "") {
      const md = Number(maxDistRaw);
      if (!Number.isNaN(md)) {
        maxDist = md;
      }
    }
    speedBands.push({ maxDist, speed });
  }
  if (speedBands.length > 0) {
    updates.geoEstimatedSpeedBands = JSON.stringify(speedBands);
  }

  // 尖峰 / 離峰時段範圍（HH:MM 字串）
  const timeRangeFields = [
    "rushHourMorningStart",
    "rushHourMorningEnd",
    "rushHourEveningStart",
    "rushHourEveningEnd",
    "lightHourEarlyEnd",
    "lightHourLateStart",
  ];
  timeRangeFields.forEach((field) => {
    const v = body[field];
    if (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim())) {
      updates[field] = v.trim();
    }
  });

  // 企業優先度：高優先 enterpriseId 清單（CSV）
  if (typeof body.highPriorityEnterpriseIdsCsv === "string") {
    const csv = body.highPriorityEnterpriseIdsCsv.trim();
    updates.highPriorityEnterpriseIdsCsv = csv;
  }

  // 企業優先度：低優先 enterpriseId 清單（CSV）
  if (typeof body.lowPriorityEnterpriseIdsCsv === "string") {
    const csv = body.lowPriorityEnterpriseIdsCsv.trim();
    updates.lowPriorityEnterpriseIdsCsv = csv;
  }

  // 司機優先層級：Relief / Secondary 司機 ID 清單（CSV）
  if (typeof body.reliefDriverIdsCsv === "string") {
    const csv = body.reliefDriverIdsCsv.trim();
    updates.reliefDriverIdsCsv = csv;
  }
  if (typeof body.secondaryDriverIdsCsv === "string") {
    const csv = body.secondaryDriverIdsCsv.trim();
    updates.secondaryDriverIdsCsv = csv;
  }

  booleanFields.forEach((field) => {
    updates[field] = body[field] === "on" || body[field] === "true";
  });

  updateConfig(updates);

  res.render("settings", {
    config: getConfig(),
    message: "參數已更新（僅作用於此測試網站，不影響 zemo-api）。",
  });
});

// ── 手動觸發暫停銷售通知（全量發送，不寫 Supabase）──
router.post("/send-all-pause-notifications", async (req, res) => {
  try {
    const moment = require("moment-timezone");
    const { prefetchDriverData, fetchReservationsWithPrefetchedDrivers } = require("../core/zemo-client");
    const { runSchedule } = require("../core/scheduler-engine");
    const { computePausePeriodsForDate } = require("../../slot-monitor/core/slot-aggregator");
    const {
      formatCombinedNewNotifications,
      sendAllNotifications,
    } = require("../../slot-monitor/core/slack-notifier");
    const slotConfig = require("../../slot-monitor/config");

    const config = getConfig();
    if (config.geoRushHourMinutes != null) process.env.GEO_RUSH_HOUR_MINUTES = String(config.geoRushHourMinutes);
    if (config.geoLightHourMinutes != null) process.env.GEO_LIGHT_HOUR_MINUTES = String(config.geoLightHourMinutes);
    if (config.geoEstimatedSpeedBands != null)
      process.env.GEO_ESTIMATED_SPEED_BANDS = typeof config.geoEstimatedSpeedBands === "string" ? config.geoEstimatedSpeedBands : JSON.stringify(config.geoEstimatedSpeedBands);

    const today = moment().tz("Asia/Taipei");
    const daysAhead = 30;
    const dates = [];
    for (let d = 1; d <= daysAhead; d++) dates.push(today.clone().add(d, "days").format("YYYY-MM-DD"));

    // 預載駕駛（1 次 API）
    const prefetched = await prefetchDriverData(dates[0], dates[dates.length - 1]);
    const allPeriods = {};

    // 並行處理（每批 5 天）
    for (let i = 0; i < dates.length; i += 5) {
      const batch = dates.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (dateStr) => {
          const { reservations, driverShifts } = await fetchReservationsWithPrefetchedDrivers(dateStr, prefetched);
          if (reservations.length === 0) return null;
          const result = await runSchedule(reservations, driverShifts, config);
          return { dateStr, pauses: computePausePeriodsForDate(result.debug || {}, driverShifts, dateStr) };
        })
      );
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const { pauses } = r.value;
        for (const cat of slotConfig.CATEGORIES) {
          const periods = pauses[cat.key] || [];
          if (periods.length > 0) {
            if (!allPeriods[cat.label]) allPeriods[cat.label] = [];
            allPeriods[cat.label].push(...periods);
          }
        }
      }
    }

    const messages = formatCombinedNewNotifications(allPeriods);
    if (messages.length > 0) {
      await sendAllNotifications(messages);
      res.render("settings", {
        config: getConfig(),
        message: `已發送 ${messages.length} 則暫停銷售通知到 Slack（共 ${Object.values(allPeriods).reduce((s, a) => s + a.length, 0)} 段）。`,
      });
    } else {
      res.render("settings", {
        config: getConfig(),
        message: "未來 60 天沒有需要暫停銷售的時段。",
      });
    }
  } catch (err) {
    res.render("settings", {
      config: getConfig(),
      message: `發送失敗：${err.message}`,
    });
  }
});

// ── 儲存 Slack Channel ID ──
router.post("/save-slack-channel", async (req, res) => {
  try {
    const channelId = (req.body.slackChannelId || "").trim();
    if (!channelId) {
      return res.render("settings", { config: getConfig(), message: "請輸入 Slack Channel ID" });
    }
    updateConfig({ slackChannelId: channelId });
    res.render("settings", { config: getConfig(), message: `Slack 頻道已更新為 ${channelId}` });
  } catch (err) {
    res.render("settings", { config: getConfig(), message: `儲存失敗：${err.message}` });
  }
});

// ── 清除 Slot Monitor 通知紀錄 ──
router.post("/reset-slot-monitor", async (req, res) => {
  try {
    const { clearAllState } = require("../../slot-monitor/core/supabase-state");
    const count = await clearAllState();
    res.render("settings", {
      config: getConfig(),
      message: `已清除 ${count} 筆通知紀錄。下次執行 Slot Monitor 將重新發送所有通知。`,
    });
  } catch (err) {
    res.render("settings", {
      config: getConfig(),
      message: `清除失敗：${err.message}`,
    });
  }
});

module.exports = router;


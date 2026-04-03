const express = require("express");
const router = express.Router();

const moment = require("moment-timezone");
const { getConfig } = require("../core/env-config");
const { runSchedule } = require("../core/scheduler-engine");
const { fetchReservationsAndShifts } = require("../core/zemo-client");
const { computePausePeriodsForDate } = require("../../slot-monitor/core/slot-aggregator");

router.get("/", async (req, res) => {
  const today = moment().format("YYYY-MM-DD");

  res.render("schedule", {
    date: today,
    options: getConfig(),
    result: null,
    error: null,
  });
});

function applyGeoConfigToProcessEnv(config) {
  if (config.geoRushHourMinutes != null) process.env.GEO_RUSH_HOUR_MINUTES = String(config.geoRushHourMinutes);
  if (config.geoLightHourMinutes != null) process.env.GEO_LIGHT_HOUR_MINUTES = String(config.geoLightHourMinutes);
  if (config.geoEstimatedSpeedBands != null) process.env.GEO_ESTIMATED_SPEED_BANDS = typeof config.geoEstimatedSpeedBands === "string" ? config.geoEstimatedSpeedBands : JSON.stringify(config.geoEstimatedSpeedBands);
  if (config.rushHourMorningStart) process.env.GEO_RUSH_HOUR_MORNING_START = config.rushHourMorningStart;
  if (config.rushHourMorningEnd) process.env.GEO_RUSH_HOUR_MORNING_END = config.rushHourMorningEnd;
  if (config.rushHourEveningStart) process.env.GEO_RUSH_HOUR_EVENING_START = config.rushHourEveningStart;
  if (config.rushHourEveningEnd) process.env.GEO_RUSH_HOUR_EVENING_END = config.rushHourEveningEnd;
  if (config.lightHourEarlyEnd) process.env.GEO_LIGHT_HOUR_EARLY_END = config.lightHourEarlyEnd;
  if (config.lightHourLateStart) process.env.GEO_LIGHT_HOUR_LATE_START = config.lightHourLateStart;
}

router.post("/", async (req, res) => {
  const date = req.body.date || moment().format("YYYY-MM-DD");
  const options = getConfig();
  applyGeoConfigToProcessEnv(options);

  try {
    const { reservations, driverShifts, driverMeta, warning } = await fetchReservationsAndShifts(date);
    const schedulingResult = await runSchedule(reservations, driverShifts, options);

    // 計算整合暫停銷售時段
    let pausePeriodsSummary = null;
    try {
      pausePeriodsSummary = computePausePeriodsForDate(
        schedulingResult.debug || {},
        driverShifts,
        date
      );
    } catch (e) {
      console.error("computePausePeriodsForDate error:", e.message);
    }

    res.render("schedule", {
      date,
      options,
      result: {
        summary: schedulingResult.summary,
        schedule: schedulingResult.schedule,
        unassigned: schedulingResult.unassignedReservations,
        fetchedReservationCount: reservations.length,
        driverMeta: driverMeta || [],
        debug: schedulingResult.debug || {},
        pausePeriodsSummary: pausePeriodsSummary || {},
      },
      error: warning || null,
    });
  } catch (err) {
    res.render("schedule", {
      date,
      options,
      result: null,
      error: err.message || String(err),
    });
  }
});

module.exports = router;


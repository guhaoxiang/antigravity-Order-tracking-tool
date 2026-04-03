"use strict";

// 載入 .env（開發環境用，Cloud Run 使用環境變數注入）
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const config = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,

  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID,

  DAYS_AHEAD: parseInt(process.env.DAYS_AHEAD, 10) || 30,
  TIMEZONE: "Asia/Taipei",

  CATEGORIES: [
    { key: "STANDARD_dropoff", label: "五人座送機", vehicleType: "STANDARD", tripType: "dropoff" },
    { key: "STANDARD_pickup",  label: "五人座接機", vehicleType: "STANDARD", tripType: "pickup" },
    { key: "LARGE_dropoff",    label: "七人座送機", vehicleType: "LARGE",    tripType: "dropoff" },
    { key: "LARGE_pickup",     label: "七人座接機", vehicleType: "LARGE",    tripType: "pickup" },
  ],

  SALES_START_HOUR: parseInt(process.env.SALES_START_HOUR, 10) || 4, // 銷售起始時間（預設 04:00）

  SLACK_MAX_CHARS: 3800,
  SLACK_DELAY_MS: 1000,

  SUPABASE_TABLE: "slot_monitor_state",
};

module.exports = config;

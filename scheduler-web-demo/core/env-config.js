const { createClient } = require("@supabase/supabase-js");
const { baselineEnv, getBaselineConfig } = require("./zemo-baseline-config");

// 載入 .env（開發環境用，Cloud Run 使用環境變數注入）
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TABLE = "scheduler_config";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentConfig = { ...baselineEnv };
let initialized = false;

/**
 * 從 Supabase 載入設定（啟動時呼叫一次）
 */
async function loadFromSupabase() {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("config")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      console.error("[env-config] Supabase load error:", error.message);
      return;
    }
    if (data && data.config) {
      currentConfig = { ...baselineEnv, ...data.config };
    }
    initialized = true;
  } catch (err) {
    console.error("[env-config] Supabase load exception:", err.message);
  }
}

/**
 * 寫入 Supabase
 */
async function persistToSupabase() {
  try {
    const { error } = await supabase.from(TABLE).upsert(
      { id: 1, config: currentConfig, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
    if (error) {
      console.error("[env-config] Supabase save error:", error.message);
    }
  } catch (err) {
    console.error("[env-config] Supabase save exception:", err.message);
  }
}

// 啟動時載入
loadFromSupabase();

function getConfig() {
  return { ...currentConfig };
}

function updateConfig(partial) {
  currentConfig = { ...currentConfig, ...partial };
  persistToSupabase();
}

function resetToBaseline() {
  currentConfig = getBaselineConfig();
  persistToSupabase();
}

module.exports = {
  getConfig,
  updateConfig,
  resetToBaseline,
  loadFromSupabase,
};

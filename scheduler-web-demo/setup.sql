-- 在 Supabase Dashboard → SQL Editor 執行此 SQL
-- https://supabase.com/dashboard/project/bcvnqsefxksogckbspln/sql

-- 參數設定表（只有一筆，id=1）
CREATE TABLE IF NOT EXISTS scheduler_config (
  id          integer PRIMARY KEY DEFAULT 1,
  config      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- 插入預設設定
INSERT INTO scheduler_config (id, config) VALUES (1, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- 在 Supabase Dashboard → SQL Editor 執行此 SQL
-- https://supabase.com/dashboard/project/bcvnqsefxksogckbspln/sql

CREATE TABLE IF NOT EXISTS slot_monitor_state (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category       text    NOT NULL,
  date           date    NOT NULL,
  pause_periods  jsonb   NOT NULL DEFAULT '[]'::jsonb,
  order_ids      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_category_date UNIQUE (category, date)
);

CREATE INDEX IF NOT EXISTS idx_slot_monitor_date ON slot_monitor_state (date);

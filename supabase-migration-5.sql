-- ============================================================
-- SHAIKH Industries — миграция для напоминаний по задачам
-- Выполните в Supabase → SQL Editor → Run
-- ============================================================

-- Флаги: какое напоминание уже отправлено (чтобы не спамить)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_confirm boolean DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_due boolean DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_overdue boolean DEFAULT false;

-- Служебная таблица для throttle проверки напоминаний
CREATE TABLE IF NOT EXISTS meta (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_public ON meta;
CREATE POLICY meta_public ON meta FOR ALL USING (true) WITH CHECK (true);

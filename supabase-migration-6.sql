-- ============================================================
-- SHAIKH Industries — язык ответов агента
-- Выполните в Supabase → SQL Editor → Run
-- ============================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS language text DEFAULT 'ru';

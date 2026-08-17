-- ============================================================
-- SHAIKH Industries — привязка менеджера к агенту
-- Выполните в Supabase → SQL Editor → Run
-- ============================================================

ALTER TABLE managers
    ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
-- ============================================================
-- SHAIKH Industries — скрипты продаж
-- Выполните в Supabase → SQL Editor → Run
-- ============================================================

CREATE TABLE IF NOT EXISTS scripts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_name text,
    lead_contact text,
    lead_need text,
    script text NOT NULL,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE scripts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scripts_public ON scripts;
CREATE POLICY scripts_public ON scripts FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_scripts_created ON scripts(created_at);
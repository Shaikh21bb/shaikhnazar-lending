-- ============================================================
-- SHAIKH Industries — миграция для календаря и делегирования
-- Выполните в Supabase → SQL Editor → Run
-- ============================================================

-- 1) Менеджеры (имя + Telegram chat ID для уведомлений)
CREATE TABLE IF NOT EXISTS managers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    chat_id text,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE managers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS managers_public ON managers;
CREATE POLICY managers_public ON managers FOR ALL USING (true) WITH CHECK (true);

-- 2) Задачи (делегирование)
CREATE TABLE IF NOT EXISTS tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    description text,
    due_at timestamptz,
    manager text,
    chat_id text,
    agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    status text DEFAULT 'pending',
    lead_name text,
    lead_contact text,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_public ON tasks;
CREATE POLICY tasks_public ON tasks FOR ALL USING (true) WITH CHECK (true);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
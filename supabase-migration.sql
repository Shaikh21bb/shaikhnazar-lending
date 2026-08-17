-- ============================================================
-- SHAIKH Industries — миграция для работающих Telegram-агентов
-- Выполните весь скрипт в Supabase → SQL Editor → Run
-- ============================================================

-- 1) Таблица «Проекты» — база знаний для обучения агентов
CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    knowledge text NOT NULL DEFAULT '',
    created_at timestamptz DEFAULT now()
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_public ON projects;
CREATE POLICY projects_public ON projects FOR ALL USING (true) WITH CHECK (true);

-- 2) Новые колонки для агентов
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS webhook_secret text,
    ADD COLUMN IF NOT EXISTS connected boolean DEFAULT false;

-- 3) История диалогов агента
CREATE TABLE IF NOT EXISTS agent_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
    chat_id text,
    role text,
    text text,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE agent_chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_chats_public ON agent_chats;
CREATE POLICY agent_chats_public ON agent_chats FOR ALL USING (true) WITH CHECK (true);

-- Индексы для быстрых выборок
CREATE INDEX IF NOT EXISTS idx_agent_chats_agent ON agent_chats(agent_id, chat_id, created_at);
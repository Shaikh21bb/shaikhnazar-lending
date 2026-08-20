-- ============================================================
-- SHAIKH Industries — ПОЛНАЯ схема базы (идемпотентная)
-- Выполните ВЕСЬ файл ОДИН раз в Supabase → SQL Editor → Run
-- Безопасно повторно: все CREATE ... IF NOT EXISTS, все ALTER ... IF NOT EXISTS
-- ============================================================

-- ------------------------------------------------------------
-- 1) Агенты (Telegram/WhatsApp боты)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    platform text DEFAULT 'telegram' CHECK (platform IN ('telegram', 'whatsapp')),
    token text,
    webhook_secret text,
    connected boolean DEFAULT false,
    status text DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    language text DEFAULT 'ru',
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agents_public ON agents;
CREATE POLICY agents_public ON agents FOR ALL USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- 2) Проекты (база знаний для обучения агентов)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 3) История диалогов агентов
-- ------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_agent_chats_agent ON agent_chats(agent_id, chat_id, created_at);

-- ------------------------------------------------------------
-- 4) Менеджеры (имя + Telegram chat ID + привязка к агенту)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS managers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    chat_id text,
    agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE managers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS managers_public ON managers;
CREATE POLICY managers_public ON managers FOR ALL USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- 5) Доступы в систему (логин + пароль) и роль
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS managers_auth (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    login text UNIQUE NOT NULL,
    password text NOT NULL,
    role text DEFAULT 'admin' CHECK (role IN ('admin', 'manager')),
    manager_id uuid REFERENCES managers(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE managers_auth ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS managers_auth_public ON managers_auth;
CREATE POLICY managers_auth_public ON managers_auth FOR ALL USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- 6) Задачи (делегирование менеджерам)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    description text,
    due_at timestamptz,
    manager text,
    chat_id text,
    agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'done')),
    lead_name text,
    lead_contact text,
    remind_confirm boolean DEFAULT false,
    remind_due boolean DEFAULT false,
    remind_overdue boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_public ON tasks;
CREATE POLICY tasks_public ON tasks FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ------------------------------------------------------------
-- 7) Скрипты продаж
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scripts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_name text,
    lead_contact text,
    lead_need text,
    script text NOT NULL DEFAULT '',
    created_at timestamptz DEFAULT now()
);

ALTER TABLE scripts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scripts_public ON scripts;
CREATE POLICY scripts_public ON scripts FOR ALL USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- 8) Служебная таблица (throttle напоминаний и пр.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_public ON meta;
CREATE POLICY meta_public ON meta FOR ALL USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- 9) Гарантия нужных колонок (идемпотентно)
-- ------------------------------------------------------------
ALTER TABLE agents ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS platform text DEFAULT 'telegram';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_secret text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS connected boolean DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS language text DEFAULT 'ru';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE managers ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_confirm boolean DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_due boolean DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_overdue boolean DEFAULT false;

ALTER TABLE scripts ADD COLUMN IF NOT EXISTS lead_need text;

-- ------------------------------------------------------------
-- 10) Учётная запись владельца (admin)
-- Пароль можно сменить после первого входа через SQL:
-- UPDATE managers_auth SET password='новый_пароль' WHERE login='admin';
-- ------------------------------------------------------------
INSERT INTO managers_auth (login, password, role)
SELECT 'admin', 'admin123', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM managers_auth WHERE login = 'admin');

-- Проверка результата
SELECT 'Схема готова' AS status, count(*) AS tables
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('agents','projects','agent_chats','managers','managers_auth','tasks','scripts','meta');
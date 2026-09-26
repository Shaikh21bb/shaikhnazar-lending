-- ============================================================
-- SHAIKH Industries — Sales Agent v1
-- Run after supabase-migration-7.sql in Supabase SQL Editor.
-- ============================================================

-- One extensible agent model; v1 implements only "sales".
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type text NOT NULL DEFAULT 'sales';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true;

-- A customer owns the AI/human handoff state independently of a channel message.
CREATE TABLE IF NOT EXISTS customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('telegram', 'whatsapp', 'local')),
    external_id text NOT NULL,
    name text,
    phone text,
    status text NOT NULL DEFAULT 'lead' CHECK (status IN ('lead', 'qualified', 'customer', 'lost')),
    ai_enabled boolean NOT NULL DEFAULT true,
    handoff_status text NOT NULL DEFAULT 'ai' CHECK (handoff_status IN ('ai', 'human')),
    handoff_reason text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_message_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_customers_agent_activity
    ON customers(agent_id, last_message_at DESC);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customers_public ON customers;
-- Customer records contain contact details and handoff state. They are only
-- accessed by the server with its service role; no browser RLS policy is added.

-- Keep the existing UI/history table and enrich it instead of replacing it.
ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'telegram';
ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS external_message_id text;
ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS tool_name text;
ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_agent_chats_customer
    ON agent_chats(customer_id, created_at);
DROP INDEX IF EXISTS idx_agent_chats_external_message;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_chats_external_message_channel
    ON agent_chats(agent_id, channel, chat_id, external_message_id)
    WHERE external_message_id IS NOT NULL;

-- Sales Agent follow-ups reuse the current calendar/tasks UI.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_chat_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_send boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS processing_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS idx_tasks_sales_followups
    ON tasks(due_at)
    WHERE source = 'sales_agent' AND auto_send = true AND sent_at IS NULL;

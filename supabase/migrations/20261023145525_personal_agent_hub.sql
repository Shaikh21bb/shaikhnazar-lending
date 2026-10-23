-- Client-facing Agent Hub. These tables are server-only because the product
-- uses its own signed session cookie rather than Supabase Auth JWTs.

ALTER TABLE public.managers_auth
    ADD COLUMN IF NOT EXISTS role text,
    ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

-- Earlier installations constrained this column to legacy roles. Remove that
-- check before writing the new owner/client values, then recreate it below.
ALTER TABLE public.managers_auth
    DROP CONSTRAINT IF EXISTS managers_auth_role_check;

UPDATE public.managers_auth
SET role = CASE
    WHEN lower(login) IN ('admin', 'shaikh') THEN 'owner'
    WHEN role = 'manager' THEN 'manager'
    ELSE 'client'
END
WHERE role IS NULL OR role NOT IN ('owner', 'client', 'manager');

ALTER TABLE public.managers_auth
    ALTER COLUMN role SET DEFAULT 'client',
    ALTER COLUMN role SET NOT NULL;

ALTER TABLE public.managers_auth
    ADD CONSTRAINT managers_auth_role_check
    CHECK (role IN ('owner', 'client', 'manager'));

CREATE TABLE IF NOT EXISTS public.personal_agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL UNIQUE REFERENCES public.managers_auth(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT 'SHAIKH Agent',
    language text NOT NULL DEFAULT 'ru' CHECK (language IN ('ru', 'kk')),
    model text NOT NULL DEFAULT 'openrouter/free',
    instructions text NOT NULL DEFAULT '',
    skills jsonb NOT NULL DEFAULT '{"notes":true,"calendar":true,"finance":true}'::jsonb,
    telegram_username text,
    telegram_bot_id text UNIQUE,
    telegram_webhook_secret_hash text UNIQUE,
    telegram_owner_chat_id text,
    telegram_owner_user_id text,
    telegram_link_hash text,
    telegram_link_expires_at timestamptz,
    telegram_connected boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT personal_agents_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT personal_agents_instructions_length CHECK (char_length(instructions) <= 6000)
);

CREATE TABLE IF NOT EXISTS public.personal_agent_secrets (
    agent_id uuid NOT NULL REFERENCES public.personal_agents(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('openrouter', 'telegram')),
    secret_box text NOT NULL,
    key_version integer NOT NULL DEFAULT 1,
    last_four text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, provider)
);

CREATE TABLE IF NOT EXISTS public.personal_agent_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES public.personal_agents(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram')),
    chat_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    text text NOT NULL,
    external_message_id text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT personal_agent_messages_text_length CHECK (char_length(text) BETWEEN 1 AND 12000)
);

CREATE UNIQUE INDEX IF NOT EXISTS personal_agent_messages_external_unique
    ON public.personal_agent_messages(agent_id, channel, chat_id, external_message_id)
    WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS personal_agent_messages_history_idx
    ON public.personal_agent_messages(agent_id, channel, chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.personal_agent_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES public.personal_agents(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('note', 'event', 'transaction')),
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    amount numeric(14, 2),
    currency text NOT NULL DEFAULT 'KZT',
    category text,
    transaction_type text CHECK (transaction_type IN ('expense', 'income')),
    event_at timestamptz,
    occurred_at timestamptz,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'deleted')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT personal_agent_records_title_length CHECK (char_length(title) BETWEEN 1 AND 240),
    CONSTRAINT personal_agent_records_body_length CHECK (char_length(body) <= 12000),
    CONSTRAINT personal_agent_records_currency CHECK (currency = 'KZT'),
    CONSTRAINT personal_agent_records_kind_fields CHECK (
        (kind = 'note' AND amount IS NULL AND transaction_type IS NULL)
        OR (kind = 'event' AND event_at IS NOT NULL AND amount IS NULL AND transaction_type IS NULL)
        OR (kind = 'transaction' AND amount > 0 AND transaction_type IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS personal_agent_records_kind_idx
    ON public.personal_agent_records(agent_id, kind, created_at DESC)
    WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS personal_agent_records_event_idx
    ON public.personal_agent_records(agent_id, event_at)
    WHERE kind = 'event' AND status <> 'deleted';

CREATE INDEX IF NOT EXISTS personal_agent_records_transaction_idx
    ON public.personal_agent_records(agent_id, occurred_at DESC)
    WHERE kind = 'transaction' AND status <> 'deleted';

ALTER TABLE public.personal_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_agent_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_agent_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.personal_agents FROM anon, authenticated;
REVOKE ALL ON TABLE public.personal_agent_secrets FROM anon, authenticated;
REVOKE ALL ON TABLE public.personal_agent_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.personal_agent_records FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.personal_agents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.personal_agent_secrets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.personal_agent_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.personal_agent_records TO service_role;

CREATE OR REPLACE FUNCTION public.personal_agent_finance_summary(
    p_agent_id uuid,
    p_from timestamptz DEFAULT NULL,
    p_to timestamptz DEFAULT NULL
)
RETURNS TABLE(currency text, expense numeric, income numeric, entry_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT
        records.currency,
        COALESCE(sum(records.amount) FILTER (WHERE records.transaction_type = 'expense'), 0)::numeric AS expense,
        COALESCE(sum(records.amount) FILTER (WHERE records.transaction_type = 'income'), 0)::numeric AS income,
        count(*)::bigint AS entry_count
    FROM public.personal_agent_records AS records
    WHERE records.agent_id = p_agent_id
      AND records.kind = 'transaction'
      AND records.status <> 'deleted'
      AND (p_from IS NULL OR records.occurred_at >= p_from)
      AND (p_to IS NULL OR records.occurred_at < p_to)
    GROUP BY records.currency;
$$;

REVOKE ALL ON FUNCTION public.personal_agent_finance_summary(uuid, timestamptz, timestamptz)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personal_agent_finance_summary(uuid, timestamptz, timestamptz)
    TO service_role;

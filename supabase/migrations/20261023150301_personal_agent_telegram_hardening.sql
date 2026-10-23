-- Harden Telegram ownership and keep webhook bearer secrets out of database
-- values and PostgREST URLs. No personal agents existed when this follow-up
-- was applied to the original production project.

ALTER TABLE public.personal_agents
    ADD COLUMN IF NOT EXISTS telegram_bot_id text,
    ADD COLUMN IF NOT EXISTS telegram_webhook_secret_hash text,
    ADD COLUMN IF NOT EXISTS telegram_owner_user_id text;

ALTER TABLE public.managers_auth
    ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS personal_agents_telegram_bot_id_unique
    ON public.personal_agents(telegram_bot_id)
    WHERE telegram_bot_id IS NOT NULL;

-- Older previews briefly stored the Telegram webhook bearer value in a
-- plaintext column. Hash it before removing the column so an already working
-- webhook is preserved without retaining the secret itself.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'personal_agents'
          AND column_name = 'telegram_webhook_secret'
    ) THEN
        EXECUTE $sql$
            UPDATE public.personal_agents
            SET telegram_webhook_secret_hash = encode(
                extensions.digest(telegram_webhook_secret, 'sha256'),
                'hex'
            )
            WHERE telegram_webhook_secret IS NOT NULL
              AND telegram_webhook_secret_hash IS NULL
        $sql$;
    END IF;
END
$$;

WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY telegram_webhook_secret_hash
               ORDER BY telegram_connected DESC, created_at ASC, id
           ) AS position
    FROM public.personal_agents
    WHERE telegram_webhook_secret_hash IS NOT NULL
)
UPDATE public.personal_agents AS agent
SET telegram_connected = false,
    telegram_webhook_secret_hash = NULL,
    telegram_owner_chat_id = NULL,
    telegram_owner_user_id = NULL,
    telegram_link_hash = NULL,
    telegram_link_expires_at = NULL,
    updated_at = now()
FROM ranked
WHERE ranked.id = agent.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS personal_agents_webhook_secret_hash_unique
    ON public.personal_agents(telegram_webhook_secret_hash)
    WHERE telegram_webhook_secret_hash IS NOT NULL;

ALTER TABLE public.personal_agents
    DROP COLUMN IF EXISTS telegram_webhook_secret;

ALTER TABLE public.personal_agent_records
    DROP CONSTRAINT IF EXISTS personal_agent_records_currency;

ALTER TABLE public.personal_agent_records
    ADD CONSTRAINT personal_agent_records_currency CHECK (currency = 'KZT');

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

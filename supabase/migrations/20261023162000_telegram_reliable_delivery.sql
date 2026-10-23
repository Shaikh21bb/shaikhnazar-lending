-- Telegram connection ownership and retry-safe personal message delivery.
-- This additive phase backfills hashes but temporarily leaves the legacy
-- plaintext column intact so the old production function keeps working while
-- the new build is verified. The next migration removes those values.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS telegram_bot_id text,
    ADD COLUMN IF NOT EXISTS webhook_secret_hash text,
    ADD COLUMN IF NOT EXISTS telegram_connection_nonce text,
    ADD COLUMN IF NOT EXISTS telegram_connection_expires_at timestamptz;

ALTER TABLE public.personal_agents
    ADD COLUMN IF NOT EXISTS telegram_connection_nonce text,
    ADD COLUMN IF NOT EXISTS telegram_connection_expires_at timestamptz;

ALTER TABLE public.personal_agent_messages
    ADD COLUMN IF NOT EXISTS processing_state text NOT NULL DEFAULT 'completed',
    ADD COLUMN IF NOT EXISTS processing_lease_token text,
    ADD COLUMN IF NOT EXISTS processing_lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS processed_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE public.personal_agent_messages
    DROP CONSTRAINT IF EXISTS personal_agent_messages_processing_state_check;

ALTER TABLE public.personal_agent_messages
    ADD CONSTRAINT personal_agent_messages_processing_state_check
    CHECK (processing_state IN ('processing', 'ready', 'completed', 'failed'));

ALTER TABLE public.personal_agent_records
    ADD COLUMN IF NOT EXISTS source_message_key text;

CREATE UNIQUE INDEX IF NOT EXISTS personal_agent_records_source_message_unique
    ON public.personal_agent_records(agent_id, source_message_key);

ALTER TABLE public.personal_agent_records
    DROP CONSTRAINT IF EXISTS personal_agent_records_source_message_key_length;

ALTER TABLE public.personal_agent_records
    ADD CONSTRAINT personal_agent_records_source_message_key_length
    CHECK (source_message_key IS NULL OR char_length(source_message_key) <= 128);

-- Preserve legacy Telegram webhooks while removing their plaintext bearer
-- values. Bot IDs are safely derived from the non-secret numeric token prefix.
UPDATE public.agents
SET webhook_secret_hash = encode(extensions.digest(webhook_secret, 'sha256'), 'hex')
WHERE webhook_secret IS NOT NULL
  AND webhook_secret_hash IS NULL;

UPDATE public.agents
SET telegram_bot_id = split_part(token, ':', 1)
WHERE platform = 'telegram'
  AND token ~ '^[0-9]{6,14}:'
  AND telegram_bot_id IS NULL;

-- If old rows already reused one Telegram bot, keep the oldest connected row
-- and explicitly invalidate the others. Telegram itself can only have one
-- active webhook, so pretending every duplicate is connected is unsafe.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY telegram_bot_id
               ORDER BY connected DESC NULLS LAST, created_at ASC NULLS LAST, id
           ) AS position
    FROM public.agents
    WHERE telegram_bot_id IS NOT NULL
)
UPDATE public.agents AS agent
SET connected = false,
    telegram_bot_id = NULL,
    webhook_secret_hash = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL
FROM ranked
WHERE ranked.id = agent.id
  AND ranked.position > 1;

-- A pre-hardening personal row without a bot ID, webhook hash, or encrypted
-- token cannot authenticate or answer safely. Remove the unusable token and
-- make the UI require an explicit reconnect instead of showing a false success.
DELETE FROM public.personal_agent_secrets AS secret
USING public.personal_agents AS agent
WHERE secret.agent_id = agent.id
  AND secret.provider = 'telegram'
  AND agent.telegram_connected = true
  AND (
      agent.telegram_bot_id IS NULL
      OR agent.telegram_webhook_secret_hash IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM public.personal_agent_secrets AS token_secret
          WHERE token_secret.agent_id = agent.id
            AND token_secret.provider = 'telegram'
      )
  );

UPDATE public.personal_agents AS agent
SET telegram_connected = false,
    telegram_username = NULL,
    telegram_bot_id = NULL,
    telegram_webhook_secret_hash = NULL,
    telegram_owner_chat_id = NULL,
    telegram_owner_user_id = NULL,
    telegram_link_hash = NULL,
    telegram_link_expires_at = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL,
    updated_at = now()
WHERE agent.telegram_connected = true
  AND (
      agent.telegram_bot_id IS NULL
      OR agent.telegram_webhook_secret_hash IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM public.personal_agent_secrets AS token_secret
          WHERE token_secret.agent_id = agent.id
            AND token_secret.provider = 'telegram'
      )
  );

DELETE FROM public.personal_agent_secrets AS secret
USING public.personal_agents AS agent
WHERE secret.agent_id = agent.id
  AND secret.provider = 'telegram'
  AND agent.telegram_connected = false
  AND agent.telegram_connection_nonce IS NOT NULL
  AND (
      agent.telegram_connection_expires_at IS NULL
      OR agent.telegram_connection_expires_at <= clock_timestamp()
  );

UPDATE public.personal_agents
SET telegram_username = NULL,
    telegram_bot_id = NULL,
    telegram_webhook_secret_hash = NULL,
    telegram_owner_chat_id = NULL,
    telegram_owner_user_id = NULL,
    telegram_link_hash = NULL,
    telegram_link_expires_at = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL,
    updated_at = now()
WHERE telegram_connected = false
  AND telegram_connection_nonce IS NOT NULL
  AND (
      telegram_connection_expires_at IS NULL
      OR telegram_connection_expires_at <= clock_timestamp()
  );

DELETE FROM public.personal_agent_secrets AS secret
USING public.personal_agents AS agent
WHERE secret.agent_id = agent.id
  AND secret.provider = 'telegram'
  AND agent.telegram_connected = false
  AND agent.telegram_connection_nonce IS NULL;

UPDATE public.personal_agents
SET telegram_username = NULL,
    telegram_bot_id = NULL,
    telegram_webhook_secret_hash = NULL,
    telegram_owner_chat_id = NULL,
    telegram_owner_user_id = NULL,
    telegram_link_hash = NULL,
    telegram_link_expires_at = NULL,
    updated_at = now()
WHERE telegram_connected = false
  AND telegram_connection_nonce IS NULL
  AND (
      telegram_bot_id IS NOT NULL
      OR telegram_webhook_secret_hash IS NOT NULL
      OR telegram_username IS NOT NULL
  );

-- Older ownership records knew only the chat ID. Keep the bot connection but
-- require a fresh one-time owner link so both Telegram chat and user are bound.
UPDATE public.personal_agents
SET telegram_owner_chat_id = NULL,
    telegram_owner_user_id = NULL,
    telegram_link_hash = NULL,
    telegram_link_expires_at = NULL,
    updated_at = now()
WHERE (telegram_owner_chat_id IS NULL) <> (telegram_owner_user_id IS NULL);

-- Personal Agent Hub owns a valid active bot in preference to a conflicting
-- legacy row. Invalidate only the legacy claim; no remote deleteWebhook call
-- occurs during migration.
UPDATE public.agents AS legacy
SET connected = false,
    telegram_bot_id = NULL,
    webhook_secret_hash = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL
WHERE legacy.telegram_bot_id IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM public.personal_agents AS personal
      WHERE personal.telegram_bot_id = legacy.telegram_bot_id
  );

UPDATE public.agents
SET connected = false,
    telegram_bot_id = NULL,
    webhook_secret_hash = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL
WHERE connected = true
  AND platform = 'telegram'
  AND (telegram_bot_id IS NULL OR webhook_secret_hash IS NULL);

UPDATE public.agents
SET telegram_bot_id = NULL,
    webhook_secret_hash = NULL,
    telegram_connection_expires_at = NULL
WHERE connected = false
  AND telegram_connection_nonce IS NULL;

UPDATE public.agents
SET telegram_bot_id = NULL,
    webhook_secret_hash = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL
WHERE connected = false
  AND telegram_connection_nonce IS NOT NULL
  AND (
      telegram_connection_expires_at IS NULL
      OR telegram_connection_expires_at <= clock_timestamp()
  );

WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY webhook_secret_hash
               ORDER BY connected DESC NULLS LAST, created_at ASC NULLS LAST, id
           ) AS position
    FROM public.agents
    WHERE webhook_secret_hash IS NOT NULL
)
UPDATE public.agents AS agent
SET connected = false,
    telegram_bot_id = NULL,
    webhook_secret_hash = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL
FROM ranked
WHERE ranked.id = agent.id
  AND ranked.position > 1;

UPDATE public.agents AS legacy
SET connected = false,
    telegram_bot_id = NULL,
    webhook_secret_hash = NULL,
    telegram_connection_nonce = NULL,
    telegram_connection_expires_at = NULL
WHERE legacy.webhook_secret_hash IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM public.personal_agents AS personal
      WHERE personal.telegram_connected = true
        AND personal.telegram_webhook_secret_hash = legacy.webhook_secret_hash
  );

CREATE UNIQUE INDEX IF NOT EXISTS agents_telegram_bot_id_unique
    ON public.agents(telegram_bot_id)
    WHERE telegram_bot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agents_webhook_secret_hash_unique
    ON public.agents(webhook_secret_hash)
    WHERE webhook_secret_hash IS NOT NULL;

-- A trigger plus a transaction-scoped advisory lock enforces uniqueness even
-- when legacy and personal connects arrive concurrently in separate tables.
CREATE OR REPLACE FUNCTION public.enforce_global_telegram_bot_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Keep references to legacy-only columns inside a separate branch. A
    -- trigger RECORD from personal_agents has no platform/token fields, and
    -- PostgreSQL resolves those fields even in a compound AND expression.
    IF TG_TABLE_NAME = 'agents' THEN
        IF NEW.platform = 'telegram' THEN
            -- Keep deploys safe if the old dashboard reconnects a bot between
            -- the additive migration and the new server release.
            IF NEW.connected = false
               AND NEW.telegram_connection_nonce IS NULL
               AND NEW.webhook_secret IS NULL THEN
                NEW.telegram_bot_id := NULL;
                NEW.webhook_secret_hash := NULL;
            ELSE
                IF NEW.telegram_bot_id IS NULL AND NEW.token ~ '^[0-9]{6,14}:' THEN
                    NEW.telegram_bot_id := split_part(NEW.token, ':', 1);
                END IF;
                IF NEW.webhook_secret IS NOT NULL THEN
                    NEW.webhook_secret_hash := encode(
                        extensions.digest(NEW.webhook_secret, 'sha256'),
                        'hex'
                    );
                END IF;
            END IF;
        END IF;
    END IF;

    IF NEW.telegram_bot_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.telegram_bot_id IS NOT DISTINCT FROM OLD.telegram_bot_id) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('shaikh-telegram-bot:' || NEW.telegram_bot_id, 0)
    );

    IF TG_TABLE_NAME = 'personal_agents' THEN
        IF EXISTS (
            SELECT 1 FROM public.agents
            WHERE telegram_bot_id = NEW.telegram_bot_id
        ) THEN
            RAISE EXCEPTION 'Telegram bot is already assigned'
                USING ERRCODE = '23505';
        END IF;
    ELSE
        IF EXISTS (
            SELECT 1 FROM public.personal_agents
            WHERE telegram_bot_id = NEW.telegram_bot_id
        ) THEN
            RAISE EXCEPTION 'Telegram bot is already assigned'
                USING ERRCODE = '23505';
        END IF;
    END IF;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS personal_agents_global_telegram_bot_id
    ON public.personal_agents;
CREATE TRIGGER personal_agents_global_telegram_bot_id
BEFORE INSERT OR UPDATE OF telegram_bot_id ON public.personal_agents
FOR EACH ROW EXECUTE FUNCTION public.enforce_global_telegram_bot_id();

DROP TRIGGER IF EXISTS agents_global_telegram_bot_id ON public.agents;
CREATE TRIGGER agents_global_telegram_bot_id
BEFORE INSERT OR UPDATE OF telegram_bot_id, webhook_secret, token, connected, telegram_connection_nonce
ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.enforce_global_telegram_bot_id();

CREATE OR REPLACE FUNCTION public.clear_stale_personal_telegram_connect(
    p_agent_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    reserved public.personal_agents%ROWTYPE;
BEGIN
    SELECT * INTO reserved
    FROM public.personal_agents
    WHERE id = p_agent_id
    FOR UPDATE;

    IF NOT FOUND
       OR reserved.telegram_connected = true
       OR reserved.telegram_connection_nonce IS NULL
       OR reserved.telegram_connection_expires_at IS NULL
       OR reserved.telegram_connection_expires_at > clock_timestamp() THEN
        RETURN false;
    END IF;

    DELETE FROM public.personal_agent_secrets
    WHERE agent_id = p_agent_id AND provider = 'telegram';

    UPDATE public.personal_agents
    SET telegram_username = NULL,
        telegram_bot_id = NULL,
        telegram_webhook_secret_hash = NULL,
        telegram_owner_chat_id = NULL,
        telegram_owner_user_id = NULL,
        telegram_link_hash = NULL,
        telegram_link_expires_at = NULL,
        telegram_connection_nonce = NULL,
        telegram_connection_expires_at = NULL,
        updated_at = now()
    WHERE id = p_agent_id;

    RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.abort_personal_telegram_connect(
    p_agent_id uuid,
    p_nonce text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    PERFORM 1
    FROM public.personal_agents
    WHERE id = p_agent_id
      AND telegram_connected = false
      AND telegram_connection_nonce = p_nonce
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    DELETE FROM public.personal_agent_secrets
    WHERE agent_id = p_agent_id AND provider = 'telegram';

    UPDATE public.personal_agents
    SET telegram_username = NULL,
        telegram_bot_id = NULL,
        telegram_webhook_secret_hash = NULL,
        telegram_owner_chat_id = NULL,
        telegram_owner_user_id = NULL,
        telegram_link_hash = NULL,
        telegram_link_expires_at = NULL,
        telegram_connection_nonce = NULL,
        telegram_connection_expires_at = NULL,
        updated_at = now()
    WHERE id = p_agent_id
      AND telegram_connected = false
      AND telegram_connection_nonce = p_nonce;

    RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_personal_agent_message(
    p_agent_id uuid,
    p_channel text,
    p_chat_id text,
    p_external_message_id text,
    p_text text,
    p_lease_token text,
    p_lease_seconds integer DEFAULT 55
)
RETURNS TABLE(
    message_id uuid,
    claim_status text,
    cached_reply text,
    cached_actions jsonb
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    claimed_message public.personal_agent_messages%ROWTYPE;
    lease_until timestamptz;
BEGIN
    IF p_external_message_id IS NULL OR p_external_message_id = '' THEN
        RAISE EXCEPTION 'external message ID is required';
    END IF;
    IF p_channel NOT IN ('web', 'telegram') THEN
        RAISE EXCEPTION 'unsupported message channel';
    END IF;

    lease_until := clock_timestamp()
        + make_interval(secs => greatest(15, least(coalesce(p_lease_seconds, 55), 120)));

    INSERT INTO public.personal_agent_messages (
        agent_id,
        channel,
        chat_id,
        role,
        text,
        external_message_id,
        metadata,
        processing_state,
        processing_lease_token,
        processing_lease_expires_at
    ) VALUES (
        p_agent_id,
        p_channel,
        left(p_chat_id, 255),
        'user',
        left(p_text, 12000),
        left(p_external_message_id, 255),
        '{}'::jsonb,
        'processing',
        p_lease_token,
        lease_until
    )
    ON CONFLICT (agent_id, channel, chat_id, external_message_id)
        WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING * INTO claimed_message;

    IF FOUND THEN
        RETURN QUERY SELECT claimed_message.id, 'claimed'::text, NULL::text, '[]'::jsonb;
        RETURN;
    END IF;

    SELECT * INTO claimed_message
    FROM public.personal_agent_messages
    WHERE agent_id = p_agent_id
      AND channel = p_channel
      AND chat_id = left(p_chat_id, 255)
      AND external_message_id = left(p_external_message_id, 255)
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'message claim disappeared';
    END IF;

    IF claimed_message.processing_state = 'completed' THEN
        RETURN QUERY SELECT claimed_message.id, 'completed'::text, NULL::text, '[]'::jsonb;
        RETURN;
    END IF;

    IF claimed_message.processing_state = 'ready' THEN
        UPDATE public.personal_agent_messages
        SET processing_lease_token = p_lease_token,
            processing_lease_expires_at = lease_until
        WHERE id = claimed_message.id;
        RETURN QUERY SELECT
            claimed_message.id,
            'ready'::text,
            claimed_message.metadata ->> 'cached_reply',
            coalesce(claimed_message.metadata -> 'actions', '[]'::jsonb);
        RETURN;
    END IF;

    IF claimed_message.processing_state = 'failed'
       OR claimed_message.processing_lease_expires_at IS NULL
       OR claimed_message.processing_lease_expires_at <= clock_timestamp() THEN
        UPDATE public.personal_agent_messages
        SET processing_state = 'processing',
            processing_lease_token = p_lease_token,
            processing_lease_expires_at = lease_until,
            last_error = NULL
        WHERE id = claimed_message.id;
        RETURN QUERY SELECT claimed_message.id, 'claimed'::text, NULL::text, '[]'::jsonb;
        RETURN;
    END IF;

    RETURN QUERY SELECT claimed_message.id, 'busy'::text, NULL::text, '[]'::jsonb;
END
$$;

CREATE OR REPLACE FUNCTION public.personal_agent_message_ready(
    p_message_id uuid,
    p_lease_token text,
    p_reply text,
    p_actions jsonb DEFAULT '[]'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    inbound public.personal_agent_messages%ROWTYPE;
BEGIN
    UPDATE public.personal_agent_messages
    SET processing_state = 'ready',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'cached_reply', left(p_reply, 4000),
            'actions', coalesce(p_actions, '[]'::jsonb)
        ),
        processing_lease_expires_at = clock_timestamp() + interval '10 minutes',
        last_error = NULL
    WHERE id = p_message_id
      AND processing_state = 'processing'
      AND processing_lease_token = p_lease_token
    RETURNING * INTO inbound;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.personal_agent_messages (
        agent_id,
        channel,
        chat_id,
        role,
        text,
        metadata,
        processing_state,
        processed_at
    ) VALUES (
        inbound.agent_id,
        inbound.channel,
        inbound.chat_id,
        'assistant',
        left(p_reply, 12000),
        jsonb_build_object('actions', coalesce(p_actions, '[]'::jsonb), 'inbound_message_id', inbound.id),
        'completed',
        clock_timestamp()
    );

    RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_personal_agent_message(
    p_message_id uuid,
    p_lease_token text
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
    WITH completed AS (
        UPDATE public.personal_agent_messages
        SET processing_state = 'completed',
            processing_lease_token = NULL,
            processing_lease_expires_at = NULL,
            processed_at = clock_timestamp(),
            last_error = NULL
        WHERE id = p_message_id
          AND processing_state = 'ready'
          AND processing_lease_token = p_lease_token
        RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM completed);
$$;

CREATE OR REPLACE FUNCTION public.fail_personal_agent_message(
    p_message_id uuid,
    p_lease_token text,
    p_error text
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
    WITH failed AS (
        UPDATE public.personal_agent_messages
        SET processing_state = 'failed',
            processing_lease_token = NULL,
            processing_lease_expires_at = NULL,
            last_error = left(coalesce(p_error, 'processing failed'), 500)
        WHERE id = p_message_id
          AND processing_state = 'processing'
          AND processing_lease_token = p_lease_token
        RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM failed);
$$;

REVOKE ALL ON FUNCTION public.claim_personal_agent_message(uuid, text, text, text, text, text, integer)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_stale_personal_telegram_connect(uuid)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abort_personal_telegram_connect(uuid, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.personal_agent_message_ready(uuid, text, text, jsonb)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_personal_agent_message(uuid, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_personal_agent_message(uuid, text, text)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_personal_agent_message(uuid, text, text, text, text, text, integer)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_stale_personal_telegram_connect(uuid)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.abort_personal_telegram_connect(uuid, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.personal_agent_message_ready(uuid, text, text, jsonb)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_personal_agent_message(uuid, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_personal_agent_message(uuid, text, text)
    TO service_role;

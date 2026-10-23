-- Fix the shared bot-ownership trigger for personal_agents rows. Legacy-only
-- fields must not be resolved on the personal_agents trigger record.

CREATE OR REPLACE FUNCTION public.enforce_global_telegram_bot_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_TABLE_NAME = 'agents' THEN
        IF NEW.platform = 'telegram' THEN
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

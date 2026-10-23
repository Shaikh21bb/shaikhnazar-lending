-- Run after the hash-aware Telegram server release is live. This removes all
-- legacy plaintext webhook bearer values and prevents future plaintext writes.

UPDATE public.agents
SET webhook_secret_hash = encode(
        extensions.digest(webhook_secret, 'sha256'),
        'hex'
    ),
    webhook_secret = NULL
WHERE webhook_secret IS NOT NULL;

CREATE OR REPLACE FUNCTION public.strip_legacy_telegram_webhook_secret()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.platform = 'telegram' AND NEW.webhook_secret IS NOT NULL THEN
        NEW.webhook_secret_hash := encode(
            extensions.digest(NEW.webhook_secret, 'sha256'),
            'hex'
        );
        NEW.webhook_secret := NULL;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS agents_strip_plaintext_telegram_webhook_secret
    ON public.agents;
CREATE TRIGGER agents_strip_plaintext_telegram_webhook_secret
BEFORE INSERT OR UPDATE OF webhook_secret ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.strip_legacy_telegram_webhook_secret();

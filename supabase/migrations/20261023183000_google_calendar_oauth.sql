-- Google OAuth tokens are encrypted by the server before they reach this table.
ALTER TABLE public.personal_agent_secrets
    DROP CONSTRAINT IF EXISTS personal_agent_secrets_provider_check;

ALTER TABLE public.personal_agent_secrets
    ADD CONSTRAINT personal_agent_secrets_provider_check
    CHECK (provider IN ('openrouter', 'telegram', 'google_calendar'));

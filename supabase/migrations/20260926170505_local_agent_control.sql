-- Private controls and transient demo requests for the local Sales Agent.
ALTER TABLE public.whatsapp_bridge_sessions
    ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS runtime jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.local_agent_tests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    input jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'expired')),
    answer text,
    error text,
    model text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);
CREATE UNIQUE INDEX IF NOT EXISTS local_agent_tests_one_active
    ON public.local_agent_tests(agent_id) WHERE state IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS local_agent_tests_expiry ON public.local_agent_tests(expires_at);
ALTER TABLE public.local_agent_tests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.local_agent_tests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.local_agent_tests TO service_role;

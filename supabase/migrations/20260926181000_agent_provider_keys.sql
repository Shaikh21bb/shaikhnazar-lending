-- Only the signed server may access encrypted, agent-scoped provider keys.
CREATE TABLE IF NOT EXISTS public.agent_provider_keys (
    agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('openrouter')),
    secret_box text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, provider)
);
ALTER TABLE public.agent_provider_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_provider_keys FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_provider_keys TO service_role;

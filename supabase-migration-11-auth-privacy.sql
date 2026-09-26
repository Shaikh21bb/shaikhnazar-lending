-- Apply only after the new server-side /api/auth/login and /api/admin/accounts
-- are deployed with SUPABASE_SERVICE_ROLE_KEY in the same environment.
-- The legacy browser login uses anon access to managers_auth and will stop
-- working if this migration is applied before the server-side release.

ALTER TABLE public.managers_auth ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS managers_auth_public ON public.managers_auth;
DROP POLICY IF EXISTS "Allow all for admin panel" ON public.managers_auth;
REVOKE ALL PRIVILEGES ON TABLE public.managers_auth FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.managers_auth TO service_role;

-- The only legitimate access path is now the server with a signed session.
-- Do not add an anon/authenticated policy to this table.

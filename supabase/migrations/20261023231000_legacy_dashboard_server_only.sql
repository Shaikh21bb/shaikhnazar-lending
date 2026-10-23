-- Legacy dashboard data is accessed only by authenticated server routes.
-- This migration intentionally removes every browser-facing RLS policy and
-- privilege from legacy tables. Deploy the server proxy and browser facade
-- before applying it to production.

ALTER TABLE public.managers_auth
    ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES public.managers(id) ON DELETE SET NULL;

-- Backfill only unambiguous exact name/login matches. Accounts that do not
-- match stay unassigned and are denied manager data until an owner links them.
WITH unique_matches AS (
    SELECT lower(trim(name)) AS normalized_name, (array_agg(id ORDER BY id))[1] AS manager_id
    FROM public.managers
    GROUP BY lower(trim(name))
    HAVING count(*) = 1
)
UPDATE public.managers_auth AS account
SET manager_id = match.manager_id
FROM unique_matches AS match
WHERE account.manager_id IS NULL
  AND lower(trim(account.login)) = match.normalized_name;

CREATE INDEX IF NOT EXISTS managers_auth_manager_id_idx
    ON public.managers_auth(manager_id);

CREATE INDEX IF NOT EXISTS agents_project_id_idx ON public.agents(project_id);
CREATE INDEX IF NOT EXISTS managers_agent_id_idx ON public.managers(agent_id);
CREATE INDEX IF NOT EXISTS tasks_agent_id_idx ON public.tasks(agent_id);
CREATE INDEX IF NOT EXISTS tasks_customer_id_idx ON public.tasks(customer_id);
CREATE INDEX IF NOT EXISTS whatsapp_outbox_task_id_idx ON public.whatsapp_outbox(task_id);

DO $$
DECLARE
    legacy_table text;
    legacy_policy record;
BEGIN
    FOREACH legacy_table IN ARRAY ARRAY[
        'agents',
        'projects',
        'agent_chats',
        'managers',
        'managers_auth',
        'tasks',
        'scripts',
        'meta',
        'leads',
        'customers',
        'sessions',
        'whatsapp_bridge_sessions',
        'whatsapp_outbox'
    ]
    LOOP
        IF to_regclass(format('public.%I', legacy_table)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', legacy_table);

        FOR legacy_policy IN
            SELECT policyname
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = legacy_table
        LOOP
            EXECUTE format(
                'DROP POLICY IF EXISTS %I ON public.%I',
                legacy_policy.policyname,
                legacy_table
            );
        END LOOP;

        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',
            legacy_table
        );
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role',
            legacy_table
        );
    END LOOP;
END
$$;

-- These are trigger helpers, not public RPC endpoints.
REVOKE ALL ON FUNCTION public.enforce_global_telegram_bot_id()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.strip_legacy_telegram_webhook_secret()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_global_telegram_bot_id() TO service_role;
GRANT EXECUTE ON FUNCTION public.strip_legacy_telegram_webhook_secret() TO service_role;

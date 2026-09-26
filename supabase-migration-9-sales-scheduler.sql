-- Sales Agent v1 scheduler. Run after migration 8.
-- The two Vault secrets must be created separately before this job is enabled:
--   sales_agent_followup_url    https://shaikh.digital/api/followups/run
--   sales_agent_cron_secret     same value as Vercel CRON_SECRET
-- Never put the secret value into a tracked migration file.

create schema if not exists extensions;
create schema if not exists vault;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault with schema vault;

create or replace function public.invoke_sales_agent_followups()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net, pg_temp
as $$
declare
    endpoint text;
    cron_secret text;
    request_id bigint;
begin
    select decrypted_secret into endpoint
      from vault.decrypted_secrets
     where name = 'sales_agent_followup_url';
    select decrypted_secret into cron_secret
      from vault.decrypted_secrets
     where name = 'sales_agent_cron_secret';

    -- The job can be installed before production credentials exist. It stays
    -- idle until both Vault secrets are configured.
    if endpoint is null or cron_secret is null then
        return null;
    end if;
    if endpoint !~ '^https://[^[:space:]]+/api/followups/run$' then
        raise exception 'Sales Agent follow-up URL must be an HTTPS endpoint';
    end if;

    select net.http_post(
        url := endpoint,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || cron_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 15000
    ) into request_id;
    return request_id;
end;
$$;

revoke all on function public.invoke_sales_agent_followups() from public, anon, authenticated;

-- cron.schedule with an existing name replaces its schedule idempotently.
select cron.schedule(
    'sales-agent-followups',
    '*/5 * * * *',
    'select public.invoke_sales_agent_followups()'
);

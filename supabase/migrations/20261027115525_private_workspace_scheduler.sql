-- The scheduler credential is generated and retained inside Postgres Vault.
-- No plaintext credential is returned, checked into source, or put in app env.
create table public.workspace_scheduler (
    singleton boolean primary key default true check (singleton),
    token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$')
);
alter table public.workspace_scheduler enable row level security;
revoke all on table public.workspace_scheduler from public, anon, authenticated, service_role;
grant select on table public.workspace_scheduler to service_role;

do $setup$
declare
    scheduler_token text;
    scheduler_job bigint;
begin
    select decrypted_secret into scheduler_token
    from vault.decrypted_secrets where name = 'shaikh_workspace_scheduler_token' limit 1;
    if scheduler_token is null then
        scheduler_token := encode(extensions.gen_random_bytes(32), 'hex');
        perform vault.create_secret(scheduler_token, 'shaikh_workspace_scheduler_token');
    end if;
    if scheduler_token !~ '^[a-f0-9]{64}$' then
        raise exception 'Workspace scheduler credential has an invalid format';
    end if;

    insert into public.workspace_scheduler(singleton, token_hash)
    values (true, encode(extensions.digest(scheduler_token, 'sha256'), 'hex'))
    on conflict (singleton) do update set token_hash = excluded.token_hash;

    select cron.schedule(
        'shaikh-workspace-reminders', '* * * * *',
        $command$
        select net.http_post(
            url := 'https://shaikh.digital/api/hub/remind',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || (
                    select decrypted_secret from vault.decrypted_secrets
                    where name = 'shaikh_workspace_scheduler_token' limit 1
                )
            ),
            body := '{}'::jsonb,
            timeout_milliseconds := 45000
        );
        $command$
    ) into scheduler_job;
    -- Activate only after the authenticated production endpoint is released.
    perform cron.alter_job(job_id := scheduler_job, active := false);
end;
$setup$;

-- To disable this feature, unschedule only its own job:
-- select cron.unschedule('shaikh-workspace-reminders');

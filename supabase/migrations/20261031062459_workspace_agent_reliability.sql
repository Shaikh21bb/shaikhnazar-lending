-- One linked WhatsApp number belongs to one root workspace. Multiple saved
-- agents are allowed, but only one can answer for that number at a time.
-- Do not repair duplicates here: review them before applying this migration.
create unique index workspace_one_enabled_whatsapp_agent
    on public.workspace_agents(root_id)
    where type = 'whatsapp' and enabled;

-- A recently decided or delivered reply remains visible even when the
-- original incoming message was created before the latest history window.
-- This expression compares only stored timestamptz values; no clock or
-- session timezone is involved, so it is safe for a generated column.
alter table public.workspace_approvals
    add column activity_at timestamptz
        generated always as (greatest(created_at, decided_at, delivered_at)) stored;
create index workspace_approvals_recent_activity
    on public.workspace_approvals(root_id, activity_at desc, id desc);

-- Transport events are partial updates. Merge them while PostgreSQL holds the
-- row lock so a concurrent full heartbeat cannot lose model/Telegram flags.
create function public.workspace_patch_runtime(
    p_device_id uuid,
    p_root_id uuid,
    p_status jsonb,
    p_model text default null
)
returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
    affected integer;
begin
    if pg_catalog.jsonb_typeof(p_status) is distinct from 'object' then
        return false;
    end if;
    if exists (
            select 1 from pg_catalog.jsonb_each(p_status) entry
            where entry.key not in ('state', 'whatsapp', 'modelReady', 'telegramDialogue', 'telegramVoice')
                or (entry.key in ('modelReady', 'telegramDialogue', 'telegramVoice')
                    and pg_catalog.jsonb_typeof(entry.value) <> 'boolean')
                or (entry.key = 'state' and entry.value not in ('"ready"'::jsonb, '"processing"'::jsonb,
                    '"error"'::jsonb, '"offline"'::jsonb, '"model_offline"'::jsonb))
                or (entry.key = 'whatsapp' and entry.value not in ('"disconnected"'::jsonb,
                    '"qr"'::jsonb, '"connected"'::jsonb, '"paused"'::jsonb))
        )
        or (p_model is not null and (p_model ~ '://' or p_model !~ '^[A-Za-z0-9_./:@+-]{0,100}$')) then
        return false;
    end if;

    update public.workspace_devices d
    set status = pg_catalog.jsonb_set(
            coalesce(d.status, '{}'::jsonb) || p_status,
            '{telegramVoice}',
            case when (coalesce(d.status, '{}'::jsonb) || p_status)->'telegramDialogue' = 'true'::jsonb
                then coalesce((coalesce(d.status, '{}'::jsonb) || p_status)->'telegramVoice', 'false'::jsonb)
                else 'false'::jsonb
            end
        ),
        model = coalesce(p_model, d.model),
        last_seen_at = now()
    where d.id = p_device_id and d.root_id = p_root_id and d.revoked_at is null;
    get diagnostics affected = row_count;
    return affected = 1;
end;
$$;

revoke all on function public.workspace_patch_runtime(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.workspace_patch_runtime(uuid, uuid, jsonb, text) to service_role;

-- Rollback is additive: drop this function/index after rolling the backend
-- back to a release that does not call workspace_patch_runtime.

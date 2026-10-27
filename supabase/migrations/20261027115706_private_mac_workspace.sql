-- Only the signed-cookie backend owns access. Vault text is never stored here:
-- jobs contain envelopes encrypted to the Mac (and replies to the browser).
create table public.workspace_devices (
    id uuid primary key default gen_random_uuid(),
    root_id uuid not null unique references public.personal_agents(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 80),
    public_key jsonb not null,
    token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
    status jsonb not null default '{"state":"offline","whatsapp":"disconnected"}'::jsonb,
    model text not null default '',
    last_seen_at timestamptz,
    last_digest_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now()
);

create table public.workspace_pairings (
    root_id uuid primary key references public.personal_agents(id) on delete cascade,
    code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create table public.workspace_agents (
    id uuid primary key default gen_random_uuid(),
    root_id uuid not null references public.personal_agents(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 80),
    type text not null check (type in ('personal', 'whatsapp')),
    rules text not null default '' check (char_length(rules) <= 6000),
    examples text not null default '' check (char_length(examples) <= 12000),
    enabled boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index workspace_one_personal_agent on public.workspace_agents(root_id) where type = 'personal';
create index workspace_agents_root on public.workspace_agents(root_id, created_at);

create table public.workspace_jobs (
    id uuid primary key default gen_random_uuid(),
    root_id uuid not null references public.personal_agents(id) on delete cascade,
    device_id uuid not null references public.workspace_devices(id) on delete cascade,
    kind text not null check (kind in ('thought', 'telegram_thought', 'whatsapp_connect', 'whatsapp_disconnect')),
    request_id text not null check (char_length(request_id) between 1 and 128),
    envelope jsonb not null,
    result_envelope jsonb,
    status text not null default 'queued' check (status in ('queued', 'processing', 'complete', 'failed', 'cancelled')),
    error_code text check (error_code in ('local_error', 'model_unavailable', 'device_replaced', 'attempts_exhausted')),
    attempts integer not null default 0,
    lease_token uuid,
    lease_until timestamptz,
    notified_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (root_id, request_id)
);
create index workspace_jobs_poll on public.workspace_jobs(device_id, status, created_at);
create index workspace_jobs_root on public.workspace_jobs(root_id, created_at desc);

create table public.workspace_reminders (
    id uuid primary key,
    root_id uuid not null references public.personal_agents(id) on delete cascade,
    job_id uuid references public.workspace_jobs(id) on delete set null,
    due_at timestamptz not null,
    status text not null default 'pending' check (status in ('pending', 'dispatching', 'sent', 'failed', 'complete', 'cancelled')),
    sent_at timestamptz,
    created_at timestamptz not null default now()
);
create index workspace_reminders_due on public.workspace_reminders(status, due_at);
create index workspace_reminders_root on public.workspace_reminders(root_id, due_at);
create index workspace_reminders_job on public.workspace_reminders(job_id);

-- WhatsApp text may use cloud processing by the owner's explicit choice. This
-- table contains only new messages needing review, never imported chat history.
create table public.workspace_approvals (
    id uuid primary key default gen_random_uuid(),
    root_id uuid not null references public.personal_agents(id) on delete cascade,
    device_id uuid not null references public.workspace_devices(id) on delete cascade,
    agent_id uuid not null references public.workspace_agents(id) on delete cascade,
    external_id text not null check (char_length(external_id) between 1 and 128),
    recipient text not null check (char_length(recipient) between 1 and 100),
    original text not null check (char_length(original) <= 8000),
    draft text not null check (char_length(draft) <= 4000),
    reason text not null check (char_length(reason) between 1 and 200),
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'dispatching', 'sent', 'failed', 'uncertain', 'expired')),
    expires_at timestamptz not null default now() + interval '24 hours',
    decided_at timestamptz,
    delivered_at timestamptz,
    created_at timestamptz not null default now(),
    unique (device_id, external_id)
);
create index workspace_approvals_root on public.workspace_approvals(root_id, status, created_at);
create index workspace_approvals_agent on public.workspace_approvals(agent_id);

-- One-time pairing and device replacement are one transaction. A replacement
-- invalidates the old token and cancels jobs encrypted to the previous key.
create function public.workspace_pair_device(p_code_hash text, p_token_hash text, p_public_key jsonb, p_name text)
returns setof public.workspace_devices
language plpgsql security invoker set search_path = '' as $$
declare
    paired_root uuid;
    paired_device uuid;
    previous_key jsonb;
begin
    delete from public.workspace_pairings
    where code_hash = p_code_hash and expires_at > now()
    returning root_id into paired_root;
    if paired_root is null then return; end if;

    select d.public_key into previous_key from public.workspace_devices d
    where d.root_id = paired_root for update;

    insert into public.workspace_devices(root_id, token_hash, public_key, name, status, last_seen_at)
    values (paired_root, p_token_hash, p_public_key, p_name, '{"state":"ready","whatsapp":"disconnected"}', now())
    on conflict (root_id) do update set
        token_hash = excluded.token_hash, public_key = excluded.public_key,
        name = excluded.name, revoked_at = null, last_seen_at = now(),
        status = '{"state":"ready","whatsapp":"disconnected"}', model = ''
    returning id into paired_device;

    if previous_key->>'n' = p_public_key->>'n' and previous_key->>'e' = p_public_key->>'e' then
        update public.workspace_jobs set status = 'queued', lease_token = null,
            lease_until = null, updated_at = now()
        where root_id = paired_root and status = 'processing';
    else
        update public.workspace_jobs set status = 'cancelled', error_code = 'device_replaced',
            lease_token = null, lease_until = null, updated_at = now()
        where root_id = paired_root and status in ('queued', 'processing');
    end if;
    update public.workspace_approvals set status = 'expired'
    where root_id = paired_root and status in ('pending', 'approved');
    return query select d.* from public.workspace_devices d where d.id = paired_device;
end;
$$;

create function public.workspace_claim_jobs(p_device_id uuid, p_root_id uuid)
returns setof public.workspace_jobs
language plpgsql security invoker set search_path = '' as $$
begin
    update public.workspace_jobs set status = 'failed', error_code = 'attempts_exhausted', updated_at = now()
    where device_id = p_device_id and root_id = p_root_id and attempts >= 5
        and (status = 'queued' or (status = 'processing' and lease_until < now()));

    return query
    with claimed as (
        select j.id from public.workspace_jobs j
        where j.device_id = p_device_id and j.root_id = p_root_id and j.attempts < 5
            and (j.status = 'queued' or (j.status = 'processing' and j.lease_until < now()))
        order by j.created_at for update skip locked limit 1
    )
    update public.workspace_jobs j set status = 'processing', attempts = j.attempts + 1,
        lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes', updated_at = now()
    from claimed where j.id = claimed.id returning j.*;
end;
$$;

create function public.workspace_complete_job(p_device_id uuid, p_root_id uuid, p_job_id uuid,
    p_lease_token uuid, p_result jsonb, p_status text, p_error_code text, p_reminders jsonb)
returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
    changed uuid;
    reminder jsonb;
begin
    update public.workspace_jobs set result_envelope = p_result, status = p_status,
        error_code = p_error_code, lease_until = null, updated_at = now()
    where id = p_job_id and device_id = p_device_id and root_id = p_root_id
        and status = 'processing' and lease_token = p_lease_token
    returning id into changed;
    if changed is null then return false; end if;
    if p_status = 'complete' then
        for reminder in select * from jsonb_array_elements(p_reminders)
        loop
            insert into public.workspace_reminders(id, root_id, job_id, due_at)
            values ((reminder->>'id')::uuid, p_root_id, p_job_id, (reminder->>'due_at')::timestamptz)
            on conflict (id) do nothing;
        end loop;
    end if;
    return true;
end;
$$;

create function public.workspace_claim_decisions(p_device_id uuid, p_root_id uuid)
returns setof public.workspace_approvals
language plpgsql security invoker set search_path = '' as $$
begin
    update public.workspace_approvals set status = 'expired'
    where device_id = p_device_id and root_id = p_root_id
        and status in ('pending', 'approved') and expires_at <= now();
    return query
    with claimed as (
        select a.id from public.workspace_approvals a
        join public.workspace_agents g on g.id = a.agent_id and g.root_id = p_root_id and g.enabled
        where a.device_id = p_device_id and a.root_id = p_root_id
            and a.status = 'approved' and a.expires_at > now()
        order by a.decided_at for update of a skip locked limit 10
    )
    update public.workspace_approvals a set status = 'dispatching'
    from claimed where a.id = claimed.id returning a.*;
end;
$$;

alter table public.workspace_devices enable row level security;
alter table public.workspace_pairings enable row level security;
alter table public.workspace_agents enable row level security;
alter table public.workspace_jobs enable row level security;
alter table public.workspace_reminders enable row level security;
alter table public.workspace_approvals enable row level security;
revoke all on table public.workspace_devices, public.workspace_pairings, public.workspace_agents,
    public.workspace_jobs, public.workspace_reminders, public.workspace_approvals from public, anon, authenticated;
grant select, insert, update, delete on table public.workspace_devices, public.workspace_pairings,
    public.workspace_agents, public.workspace_jobs, public.workspace_reminders, public.workspace_approvals to service_role;
revoke all on function public.workspace_pair_device(text, text, jsonb, text),
    public.workspace_claim_jobs(uuid, uuid),
    public.workspace_complete_job(uuid, uuid, uuid, uuid, jsonb, text, text, jsonb),
    public.workspace_claim_decisions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.workspace_pair_device(text, text, jsonb, text),
    public.workspace_claim_jobs(uuid, uuid),
    public.workspace_complete_job(uuid, uuid, uuid, uuid, jsonb, text, text, jsonb),
    public.workspace_claim_decisions(uuid, uuid) to service_role;

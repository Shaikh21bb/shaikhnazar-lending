-- New personal WhatsApp activity only. This stores no Obsidian material,
-- provider sessions, historical imports or downloaded media.
alter table public.workspace_devices add column whatsapp_inbox_since timestamptz;
create unique index workspace_devices_id_root_unique on public.workspace_devices(id, root_id);

create table public.workspace_whatsapp_threads (
    id uuid primary key default gen_random_uuid(),
    root_id uuid not null references public.personal_agents(id) on delete cascade,
    device_id uuid not null,
    recipient text not null check (recipient ~ '^([0-9]{5,20}@s\.whatsapp\.net|[0-9]{5,30}@lid)$'),
    contact_name text check (char_length(contact_name) <= 128),
    last_message_at timestamptz not null,
    last_message_id text not null check (last_message_id ~ '^[a-f0-9]{64}$'),
    last_direction text not null check (last_direction in ('incoming', 'outgoing', 'system')),
    last_status text not null check (last_status in ('received', 'processing', 'awaiting_approval', 'answered', 'skipped', 'sending', 'sent', 'uncertain', 'failed')),
    last_origin text not null check (last_origin in ('live', 'self_check')),
    last_preview text not null default '' check (char_length(last_preview) <= 240),
    created_at timestamptz not null default now(),
    unique (device_id, recipient),
    unique (id, root_id, device_id),
    foreign key (device_id, root_id) references public.workspace_devices(id, root_id) on delete cascade
);
create index workspace_whatsapp_threads_root_page on public.workspace_whatsapp_threads(root_id, last_message_at desc, id desc);

create table public.workspace_whatsapp_messages (
    id text primary key check (id ~ '^[a-f0-9]{64}$'),
    root_id uuid not null references public.personal_agents(id) on delete cascade,
    device_id uuid not null,
    thread_id uuid not null,
    agent_id uuid references public.workspace_agents(id) on delete set null,
    direction text not null check (direction in ('incoming', 'outgoing', 'system')),
    actor text not null check (actor in ('contact', 'agent', 'system')),
    kind text not null check (kind in ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'unsupported')),
    text text check (char_length(text) <= 8000),
    status text not null check (status in ('received', 'processing', 'awaiting_approval', 'answered', 'skipped', 'sending', 'sent', 'uncertain', 'failed')),
    occurred_at timestamptz not null,
    updated_at timestamptz not null default now(),
    revision integer not null check (revision > 0),
    approval_id uuid references public.workspace_approvals(id) on delete set null,
    reply_to_id text check (reply_to_id ~ '^[a-f0-9]{64}$'),
    origin text not null check (origin in ('live', 'self_check')),
    reason text check (char_length(reason) <= 80),
    foreign key (thread_id, root_id, device_id) references public.workspace_whatsapp_threads(id, root_id, device_id) on delete cascade,
    check (kind <> 'text' or char_length(btrim(text)) > 0),
    check ((direction = 'incoming' and actor = 'contact' and status in ('received', 'processing', 'awaiting_approval', 'answered', 'skipped'))
        or (direction = 'outgoing' and actor in ('agent', 'system') and status in ('sending', 'sent', 'uncertain', 'failed'))
        or (direction = 'system' and actor = 'system' and origin = 'self_check'))
);
create index workspace_whatsapp_messages_thread_page on public.workspace_whatsapp_messages(root_id, thread_id, occurred_at desc, id desc);
create index workspace_whatsapp_messages_approval on public.workspace_whatsapp_messages(root_id, approval_id) where approval_id is not null;

alter table public.workspace_whatsapp_threads enable row level security;
alter table public.workspace_whatsapp_messages enable row level security;
revoke all on public.workspace_whatsapp_threads, public.workspace_whatsapp_messages from public, anon, authenticated;
grant select, insert, update, delete on public.workspace_whatsapp_threads, public.workspace_whatsapp_messages to service_role;

-- The authenticated server supplies root/device identity. Locking the device
-- serializes batches, including empty capture announcements, and rechecks revoke.
create function public.workspace_ingest_whatsapp_inbox(
    p_root_id uuid, p_device_id uuid, p_capture_since timestamptz, p_events jsonb
) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
    v_device public.workspace_devices%rowtype;
    v_existing public.workspace_whatsapp_messages%rowtype;
    v_event jsonb;
    v_thread_id uuid;
    v_id text;
    v_recipient text;
    v_revision integer;
    v_at timestamptz;
    v_agent uuid;
    v_approval uuid;
    v_text text;
    v_direction text;
    v_actor text;
    v_status text;
    v_kind text;
    v_origin text;
    v_name text;
    v_affected integer;
    v_preview text;
begin
    if p_root_id is null or p_device_id is null or p_capture_since is null or not isfinite(p_capture_since)
        or p_capture_since > now() + interval '5 minutes'
        or p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 25 then
        raise exception 'Invalid inbox batch' using errcode = '22023';
    end if;
    select * into v_device from public.workspace_devices
        where id = p_device_id and root_id = p_root_id and revoked_at is null for update;
    if not found then return null; end if;
    if not exists (select 1 from public.personal_agents p join public.managers_auth a on a.id = p.account_id
        where p.id = p_root_id and a.disabled_at is null
        and (a.role in ('owner', 'client') or lower(a.login) in ('admin', 'shaikh'))) then return null; end if;

    for v_event in select value from jsonb_array_elements(p_events) loop
        if jsonb_typeof(v_event) <> 'object'
            or not (v_event ?& array['id','recipient','direction','actor','kind','text','status','occurredAt','revision','origin'])
            or (v_event - array['id','recipient','contactName','agentId','direction','actor','kind','text','status','occurredAt','revision','approvalId','replyToId','origin','reason']) <> '{}'::jsonb
            or exists (select 1 from jsonb_each(v_event) e where e.key in ('id','recipient','direction','actor','kind','status','occurredAt','origin') and jsonb_typeof(e.value) <> 'string')
            or exists (select 1 from jsonb_each(v_event) e where e.key in ('text','contactName','agentId','approvalId','replyToId','reason') and jsonb_typeof(e.value) not in ('string','null'))
            or jsonb_typeof(v_event->'revision') <> 'number' or (v_event->>'revision') !~ '^[1-9][0-9]{0,9}$'
            or (v_event->>'revision')::numeric > 2147483647 then
            raise exception 'Invalid inbox event' using errcode = '22023';
        end if;
        v_id := v_event->>'id';
        v_recipient := v_event->>'recipient';
        v_direction := v_event->>'direction';
        v_actor := v_event->>'actor';
        v_status := v_event->>'status';
        v_kind := v_event->>'kind';
        v_origin := v_event->>'origin';
        v_text := v_event->>'text';
        v_name := nullif(v_event->>'contactName', '');
        v_revision := (v_event->>'revision')::integer;
        if v_id !~ '^[a-f0-9]{64}$' or v_recipient !~ '^([0-9]{5,20}@s\.whatsapp\.net|[0-9]{5,30}@lid)$'
            or v_direction not in ('incoming', 'outgoing', 'system') or v_actor not in ('contact', 'agent', 'system')
            or v_status not in ('received', 'processing', 'awaiting_approval', 'answered', 'skipped', 'sending', 'sent', 'uncertain', 'failed')
            or v_kind not in ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'unsupported')
            or v_origin not in ('live', 'self_check') or char_length(v_text) > 8000 or char_length(v_name) > 128
            or char_length(v_event->>'reason') > 80 or (v_kind = 'text' and coalesce(char_length(btrim(v_text)), 0) = 0)
            or (v_event->>'replyToId' is not null and (v_event->>'replyToId') !~ '^[a-f0-9]{64}$')
            or (v_event->>'agentId' is not null and (v_event->>'agentId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
            or (v_event->>'approvalId' is not null and (v_event->>'approvalId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
            or (v_direction = 'incoming' and (v_actor <> 'contact' or v_status not in ('received','processing','awaiting_approval','answered','skipped')))
            or (v_direction = 'outgoing' and (v_actor = 'contact' or v_status not in ('sending','sent','uncertain','failed')))
            or (v_direction = 'system' and (v_actor <> 'system' or v_origin <> 'self_check')) then
            raise exception 'Invalid inbox event' using errcode = '22023';
        end if;
        begin
            v_at := (v_event->>'occurredAt')::timestamptz;
        exception when others then
            raise exception 'Invalid inbox timestamp' using errcode = '22023';
        end;
        if not isfinite(v_at) or v_at < p_capture_since or v_at > now() + interval '5 minutes' then
            raise exception 'Invalid inbox timestamp' using errcode = '22023';
        end if;
        v_agent := (v_event->>'agentId')::uuid;
        v_approval := (v_event->>'approvalId')::uuid;
        if v_agent is not null and not exists (select 1 from public.workspace_agents a
            where a.id = v_agent and a.root_id = p_root_id and a.type = 'whatsapp') then
            raise exception 'Invalid inbox agent' using errcode = '22023';
        end if;
        if v_approval is not null and not exists (select 1 from public.workspace_approvals a
            where a.id = v_approval and a.root_id = p_root_id and a.device_id = p_device_id
            and a.recipient = v_recipient and (v_agent is null or a.agent_id = v_agent)) then
            raise exception 'Invalid inbox approval' using errcode = '22023';
        end if;
        v_preview := left(coalesce(nullif(v_text, ''), case v_kind
            when 'image' then 'Фото' when 'video' then 'Видео' when 'audio' then 'Голосовое сообщение'
            when 'document' then 'Документ' when 'sticker' then 'Стикер' when 'location' then 'Местоположение'
            when 'contact' then 'Контакт' else 'Сообщение' end), 240);

        select * into v_existing from public.workspace_whatsapp_messages where id = v_id for update;
        if found then
            if v_existing.root_id <> p_root_id or v_existing.device_id <> p_device_id
                or v_existing.direction <> v_direction or v_existing.origin <> v_origin
                or not exists (select 1 from public.workspace_whatsapp_threads t where t.id = v_existing.thread_id and t.recipient = v_recipient) then
                raise exception 'Inbox identity is immutable' using errcode = '22023';
            end if;
            if v_existing.revision >= v_revision then continue; end if;
            v_thread_id := v_existing.thread_id;
        else
            insert into public.workspace_whatsapp_threads (root_id, device_id, recipient, contact_name,
                last_message_at, last_message_id, last_direction, last_status, last_origin, last_preview)
            values (p_root_id, p_device_id, v_recipient, v_name, v_at, v_id, v_direction, v_status, v_origin, v_preview)
            on conflict (device_id, recipient) do update set contact_name = coalesce(excluded.contact_name, workspace_whatsapp_threads.contact_name)
            returning id into v_thread_id;
        end if;

        insert into public.workspace_whatsapp_messages (id, root_id, device_id, thread_id, agent_id, direction, actor, kind,
            text, status, occurred_at, revision, approval_id, reply_to_id, origin, reason)
        values (v_id, p_root_id, p_device_id, v_thread_id, v_agent, v_direction, v_actor, v_kind, v_text, v_status, v_at,
            v_revision, v_approval, v_event->>'replyToId', v_origin, v_event->>'reason')
        on conflict (id) do update set agent_id = excluded.agent_id, actor = excluded.actor, kind = excluded.kind,
            text = excluded.text, status = excluded.status, occurred_at = excluded.occurred_at, revision = excluded.revision,
            approval_id = excluded.approval_id, reply_to_id = excluded.reply_to_id, reason = excluded.reason, updated_at = now()
        where workspace_whatsapp_messages.root_id = excluded.root_id
            and workspace_whatsapp_messages.device_id = excluded.device_id
            and workspace_whatsapp_messages.thread_id = excluded.thread_id
            and workspace_whatsapp_messages.direction = excluded.direction
            and workspace_whatsapp_messages.origin = excluded.origin
            and workspace_whatsapp_messages.revision < excluded.revision;
        get diagnostics v_affected = row_count;
        if v_affected <> 1 then
            -- Also covers a concurrent collision with another device/root: a
            -- global event ID can never be used to move or overwrite its row.
            raise exception 'Inbox identity is immutable' using errcode = '22023';
        end if;

        update public.workspace_whatsapp_threads t set contact_name = coalesce(v_name, t.contact_name),
            last_message_at = m.occurred_at, last_message_id = m.id, last_direction = m.direction,
            last_status = m.status, last_origin = m.origin, last_preview = left(coalesce(nullif(m.text, ''), case m.kind
                when 'image' then 'Фото' when 'video' then 'Видео' when 'audio' then 'Голосовое сообщение'
                when 'document' then 'Документ' when 'sticker' then 'Стикер' when 'location' then 'Местоположение'
                when 'contact' then 'Контакт' else 'Сообщение' end), 240)
        from lateral (select x.* from public.workspace_whatsapp_messages x
            where x.thread_id = v_thread_id and x.root_id = p_root_id order by x.occurred_at desc, x.id desc limit 1) m
        where t.id = v_thread_id and t.root_id = p_root_id;
    end loop;
    update public.workspace_devices set whatsapp_inbox_since = coalesce(whatsapp_inbox_since, p_capture_since)
        where id = p_device_id and root_id = p_root_id and revoked_at is null;
    return jsonb_array_length(p_events);
end;
$$;

-- Bound search and keyset arguments avoid interpolating PostgREST filter syntax.
create function public.workspace_whatsapp_threads_page(
    p_root_id uuid, p_search text default null, p_before_at timestamptz default null,
    p_before_id uuid default null, p_limit integer default 26, p_thread_id uuid default null
) returns table (
    id uuid, root_id uuid, device_id uuid, recipient text, contact_name text, last_message_at timestamptz,
    last_message_id text, last_direction text, last_status text, last_origin text, last_preview text, needs_approval boolean
)
language sql stable security invoker set search_path = '' as $$
    select t.id, t.root_id, t.device_id, t.recipient, t.contact_name, t.last_message_at,
        t.last_message_id, t.last_direction, t.last_status, t.last_origin, t.last_preview,
        exists (select 1 from public.workspace_whatsapp_messages m join public.workspace_approvals a
            on a.id = m.approval_id and a.root_id = m.root_id and a.device_id = m.device_id
            where m.thread_id = t.id and m.root_id = p_root_id and a.recipient = t.recipient
            and a.status = 'pending' and a.expires_at > now())
    from public.workspace_whatsapp_threads t
    where t.root_id = p_root_id
        and (p_thread_id is null or t.id = p_thread_id)
        and (p_search is null or strpos(lower(coalesce(t.contact_name, '')), lower(p_search)) > 0
            or strpos(lower(t.recipient), lower(p_search)) > 0)
        and (p_before_at is null or (t.last_message_at, t.id) < (p_before_at, p_before_id))
    order by t.last_message_at desc, t.id desc limit greatest(1, least(coalesce(p_limit, 26), 26));
$$;

create function public.workspace_whatsapp_messages_page(
    p_root_id uuid, p_thread_id uuid, p_before_at timestamptz default null,
    p_before_id text default null, p_limit integer default 51
) returns setof public.workspace_whatsapp_messages
language sql stable security invoker set search_path = '' as $$
    select m.* from public.workspace_whatsapp_messages m
    where m.root_id = p_root_id and m.thread_id = p_thread_id
        and (p_before_at is null or (m.occurred_at, m.id) < (p_before_at, p_before_id))
    order by m.occurred_at desc, m.id desc limit greatest(1, least(coalesce(p_limit, 51), 51));
$$;

revoke all on function public.workspace_ingest_whatsapp_inbox(uuid, uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.workspace_whatsapp_threads_page(uuid, text, timestamptz, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.workspace_whatsapp_messages_page(uuid, uuid, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.workspace_ingest_whatsapp_inbox(uuid, uuid, timestamptz, jsonb) to service_role;
grant execute on function public.workspace_whatsapp_threads_page(uuid, text, timestamptz, uuid, integer, uuid) to service_role;
grant execute on function public.workspace_whatsapp_messages_page(uuid, uuid, timestamptz, text, integer) to service_role;

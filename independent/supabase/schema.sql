-- Private Cardputer backend. Apply to a fresh Supabase project.
-- Do not apply the upstream ElatoAI demo migrations to this project.

create table if not exists public.cv_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  character_name text not null default 'Cardputer' check (length(character_name) between 1 and 80),
  system_prompt text not null default 'You are a friendly conversational companion. Speak naturally and keep replies to one to three short sentences.' check (length(system_prompt) between 1 and 8000),
  voice_name text not null default 'Aoede' check (length(voice_name) between 1 and 48),
  volume integer not null default 70 check (volume between 0 and 100),
  updated_at timestamptz not null default now()
);

create table if not exists public.cv_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  mac text not null check (mac ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists cv_one_enabled_device_per_owner
  on public.cv_devices(owner_id) where enabled;
create unique index if not exists cv_one_enabled_device_per_mac
  on public.cv_devices(mac) where enabled;

-- used_seconds includes the full reservation for active or abandoned sessions.
-- A normal disconnect refunds unused seconds to its ORIGINAL UTC date.
create table if not exists public.cv_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  used_seconds integer not null default 0 check (used_seconds >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, usage_date)
);

create table if not exists public.cv_voice_leases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.cv_devices(id) on delete cascade,
  usage_date date not null,
  reserved_seconds integer not null check (reserved_seconds between 1 and 240),
  elapsed_seconds integer check (elapsed_seconds between 0 and reserved_seconds),
  state text not null default 'active' check (state in ('active', 'finished', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  foreign key (owner_id, usage_date) references public.cv_usage(owner_id, usage_date) on delete cascade
);
create unique index if not exists cv_one_active_lease_per_owner
  on public.cv_voice_leases(owner_id) where state = 'active';
create index if not exists cv_voice_leases_device_id_idx
  on public.cv_voice_leases(device_id);
create index if not exists cv_voice_leases_owner_usage_date_idx
  on public.cv_voice_leases(owner_id, usage_date);

create table if not exists public.cv_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.cv_devices(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) between 1 and 12000),
  created_at timestamptz not null default now()
);
create index if not exists cv_messages_owner_created
  on public.cv_messages(owner_id, created_at desc, id desc);
create index if not exists cv_messages_device_id_idx
  on public.cv_messages(device_id);

alter table public.cv_settings enable row level security;
alter table public.cv_devices enable row level security;
alter table public.cv_usage enable row level security;
alter table public.cv_voice_leases enable row level security;
alter table public.cv_messages enable row level security;

-- The browser can read its own records, but writes go through the server.
-- In particular it cannot mint credentials, change usage, or reserve sessions.
revoke all on public.cv_settings, public.cv_devices, public.cv_usage,
  public.cv_voice_leases, public.cv_messages from public, anon, authenticated;
grant select on public.cv_settings, public.cv_usage, public.cv_voice_leases,
  public.cv_messages to authenticated;
grant select (id, owner_id, name, mac, enabled, created_at, revoked_at)
  on public.cv_devices to authenticated;
grant all on public.cv_settings, public.cv_devices, public.cv_usage,
  public.cv_voice_leases, public.cv_messages to service_role;

drop policy if exists cv_owner_read_settings on public.cv_settings;
create policy cv_owner_read_settings on public.cv_settings for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists cv_owner_read_devices on public.cv_devices;
create policy cv_owner_read_devices on public.cv_devices for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists cv_owner_read_usage on public.cv_usage;
create policy cv_owner_read_usage on public.cv_usage for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists cv_owner_read_leases on public.cv_voice_leases;
create policy cv_owner_read_leases on public.cv_voice_leases for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists cv_owner_read_messages on public.cv_messages;
create policy cv_owner_read_messages on public.cv_messages for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.cv_reserve_session(
  p_owner_id uuid, p_device_id uuid, p_daily_seconds integer, p_session_seconds integer
) returns table (id uuid, max_seconds integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz;
  v_date date;
  v_used integer;
  v_seconds integer;
  v_lease_id uuid;
begin
  if p_daily_seconds is null or p_daily_seconds not between 60 and 1800
     or p_session_seconds is null or p_session_seconds not between 20 and 240 then
    raise exception 'invalid_voice_limits';
  end if;

  -- The owner-wide lock serializes requests even on opposite sides of midnight.
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
  v_now := clock_timestamp();
  v_date := (v_now at time zone 'UTC')::date;

  if not exists (select 1 from public.cv_devices d where d.id = p_device_id and d.owner_id = p_owner_id and d.enabled) then
    raise exception 'device_unavailable';
  end if;

  update public.cv_voice_leases l set state = 'expired', elapsed_seconds = reserved_seconds,
    finished_at = expires_at
    where l.owner_id = p_owner_id and l.state = 'active' and l.expires_at <= v_now;
  if exists (select 1 from public.cv_voice_leases l where l.owner_id = p_owner_id and l.state = 'active') then
    raise exception 'voice_session_active';
  end if;

  insert into public.cv_usage(owner_id, usage_date) values (p_owner_id, v_date)
    on conflict (owner_id, usage_date) do nothing;
  select u.used_seconds into v_used from public.cv_usage u
    where u.owner_id = p_owner_id and u.usage_date = v_date for update;
  v_seconds := least(p_session_seconds, p_daily_seconds - v_used);
  if v_seconds <= 0 then raise exception 'daily_voice_limit'; end if;

  update public.cv_usage u set used_seconds = used_seconds + v_seconds, updated_at = v_now
    where u.owner_id = p_owner_id and u.usage_date = v_date;
  insert into public.cv_voice_leases(owner_id, device_id, usage_date, reserved_seconds, created_at, expires_at)
    values (p_owner_id, p_device_id, v_date, v_seconds, v_now,
            v_now + make_interval(secs => v_seconds + 30))
    returning cv_voice_leases.id into v_lease_id;
  return query select v_lease_id, v_seconds;
end;
$$;

create or replace function public.cv_finish_session(p_lease_id uuid, p_elapsed_seconds integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner_id uuid;
  v_lease public.cv_voice_leases%rowtype;
  v_actual integer;
  v_now timestamptz;
begin
  if p_elapsed_seconds is null or p_elapsed_seconds not between 0 and 86400 then
    raise exception 'invalid_elapsed_seconds';
  end if;
  select l.owner_id into v_owner_id from public.cv_voice_leases l where l.id = p_lease_id;
  if not found then raise exception 'lease_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 0));
  select * into v_lease from public.cv_voice_leases l where l.id = p_lease_id for update;
  if not found then raise exception 'lease_not_found'; end if;
  if v_lease.state <> 'active' then return; end if;
  v_now := clock_timestamp();
  if v_lease.expires_at <= v_now then
    update public.cv_voice_leases set state = 'expired', elapsed_seconds = reserved_seconds,
      finished_at = expires_at where id = p_lease_id;
    return;
  end if;
  v_actual := least(v_lease.reserved_seconds, p_elapsed_seconds);
  update public.cv_usage set used_seconds = greatest(0, used_seconds - (v_lease.reserved_seconds - v_actual)),
    updated_at = v_now where owner_id = v_lease.owner_id and usage_date = v_lease.usage_date;
  update public.cv_voice_leases set state = 'finished', elapsed_seconds = v_actual,
    finished_at = v_now where id = p_lease_id;
end;
$$;

create or replace function public.cv_append_transcript(
  p_owner_id uuid, p_device_id uuid, p_role text, p_content text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_role is null or p_role not in ('user', 'assistant') or p_content is null
     or length(p_content) not between 1 and 12000 then raise exception 'invalid_transcript'; end if;
  if not exists (select 1 from public.cv_devices d where d.id = p_device_id and d.owner_id = p_owner_id) then
    raise exception 'device_unavailable';
  end if;
  -- Also serializes pruning so concurrent responses cannot grow history forever.
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 1));
  insert into public.cv_messages(owner_id, device_id, role, content, created_at)
    values (p_owner_id, p_device_id, p_role, p_content, clock_timestamp());
  delete from public.cv_messages m where m.owner_id = p_owner_id and m.id in (
    select older.id from public.cv_messages older where older.owner_id = p_owner_id
    order by older.created_at desc, older.id desc offset 200
  );
end;
$$;

revoke all on function public.cv_reserve_session(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.cv_finish_session(uuid, integer) from public, anon, authenticated;
revoke all on function public.cv_append_transcript(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cv_reserve_session(uuid, uuid, integer, integer) to service_role;
grant execute on function public.cv_finish_session(uuid, integer) to service_role;
grant execute on function public.cv_append_transcript(uuid, uuid, text, text) to service_role;

-- Shared bring-your-own-key accounting. This schema stores only SHA-256 key
-- fingerprints, bounded counters, and leases; never API keys, MACs, or chats.
-- Apply alongside schema.sql. It does not create accounts or change plans.

create table if not exists public.cv_byok_global_days (
  usage_date date primary key,
  used_seconds integer not null default 0 check (used_seconds >= 0),
  attempts integer not null default 0 check (attempts between 0 and 100),
  updated_at timestamptz not null default now()
);

create table if not exists public.cv_byok_key_days (
  usage_date date not null references public.cv_byok_global_days(usage_date) on delete cascade,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  used_seconds integer not null default 0 check (used_seconds >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_date, fingerprint)
);

create table if not exists public.cv_byok_leases (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  usage_date date not null,
  reserved_seconds integer not null check (reserved_seconds between 1 and 240),
  elapsed_seconds integer check (elapsed_seconds between 0 and reserved_seconds),
  state text not null default 'active' check (state in ('active', 'finished', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  foreign key (usage_date, fingerprint)
    references public.cv_byok_key_days(usage_date, fingerprint) on delete cascade
);

-- One active connection per key across UTC dates, including a midnight rollover.
create unique index if not exists cv_byok_one_active_key
  on public.cv_byok_leases(fingerprint) where state = 'active';
create index if not exists cv_byok_leases_key_day
  on public.cv_byok_leases(usage_date, fingerprint);

alter table public.cv_byok_global_days enable row level security;
alter table public.cv_byok_key_days enable row level security;
alter table public.cv_byok_leases enable row level security;

-- No browser/user policies. Only the trusted server may inspect or mutate
-- fingerprints and allowance; provider keys are not authentication to this DB.
revoke all on public.cv_byok_global_days, public.cv_byok_key_days,
  public.cv_byok_leases from public, anon, authenticated;
grant select, insert, update, delete on public.cv_byok_global_days,
  public.cv_byok_key_days, public.cv_byok_leases to service_role;

create or replace function public.cv_byok_reserve_session(
  p_fingerprint text,
  p_key_daily_seconds integer,
  p_global_daily_seconds integer,
  p_session_seconds integer,
  p_max_attempts integer
) returns table (id uuid, max_seconds integer)
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  v_date date;
  v_global_used integer;
  v_key_used integer;
  v_attempts integer;
  v_seconds integer;
  v_lease_id uuid;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'byok_invalid_fingerprint';
  end if;
  if p_key_daily_seconds is null or p_key_daily_seconds not between 1 and 600
     or p_global_daily_seconds is null or p_global_daily_seconds not between 1 and 1200
     or p_session_seconds is null or p_session_seconds not between 1 and 240
     or p_max_attempts is null or p_max_attempts not between 1 and 100 then
    raise exception 'byok_invalid_limits';
  end if;

  -- A single short transaction lock covers every key/day and settlement.
  -- No provider/network operations occur while holding this lock.
  perform pg_advisory_xact_lock(49317, 1);
  v_now := clock_timestamp();
  v_date := (v_now at time zone 'UTC')::date;

  -- At most 100 accepted reservations/fingerprints per UTC day are created.
  -- Parent deletion prunes old key-day rows and leases through indexed FKs.
  delete from public.cv_byok_global_days where usage_date < v_date - 7;
  update public.cv_byok_leases set state = 'expired',
    elapsed_seconds = reserved_seconds, finished_at = expires_at
    where state = 'active' and expires_at <= v_now;

  if exists (select 1 from public.cv_byok_leases
             where fingerprint = p_fingerprint and state = 'active') then
    raise exception 'byok_key_session_active';
  end if;
  if (select count(*) from public.cv_byok_leases where state = 'active') >= 2 then
    raise exception 'byok_global_session_limit';
  end if;

  insert into public.cv_byok_global_days(usage_date) values (v_date)
    on conflict (usage_date) do nothing;
  select used_seconds, attempts into v_global_used, v_attempts
    from public.cv_byok_global_days where usage_date = v_date for update;
  if v_attempts >= p_max_attempts then raise exception 'byok_attempt_limit'; end if;
  if v_global_used >= p_global_daily_seconds then raise exception 'byok_global_daily_limit'; end if;

  insert into public.cv_byok_key_days(usage_date, fingerprint) values (v_date, p_fingerprint)
    on conflict (usage_date, fingerprint) do nothing;
  select used_seconds into v_key_used from public.cv_byok_key_days
    where usage_date = v_date and fingerprint = p_fingerprint for update;
  if v_key_used >= p_key_daily_seconds then raise exception 'byok_key_daily_limit'; end if;

  v_seconds := least(p_session_seconds, p_key_daily_seconds - v_key_used,
                    p_global_daily_seconds - v_global_used);
  update public.cv_byok_global_days set used_seconds = used_seconds + v_seconds,
    attempts = attempts + 1, updated_at = v_now where usage_date = v_date;
  update public.cv_byok_key_days set used_seconds = used_seconds + v_seconds,
    updated_at = v_now where usage_date = v_date and fingerprint = p_fingerprint;
  insert into public.cv_byok_leases(fingerprint, usage_date, reserved_seconds, created_at, expires_at)
    values (p_fingerprint, v_date, v_seconds, v_now,
            v_now + make_interval(secs => v_seconds + 30))
    returning cv_byok_leases.id into v_lease_id;
  return query select v_lease_id, v_seconds;
end;
$$;

create or replace function public.cv_byok_finish_session(p_lease_id uuid, p_elapsed_seconds integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_lease public.cv_byok_leases%rowtype;
  v_actual integer;
  v_now timestamptz;
begin
  if p_elapsed_seconds is null or p_elapsed_seconds not between 0 and 86400 then
    raise exception 'byok_invalid_elapsed';
  end if;
  perform pg_advisory_xact_lock(49317, 1);
  v_now := clock_timestamp();
  delete from public.cv_byok_global_days
    where usage_date < (v_now at time zone 'UTC')::date - 7;
  select * into v_lease from public.cv_byok_leases where id = p_lease_id for update;
  if not found then raise exception 'byok_lease_not_found'; end if;
  if v_lease.state <> 'active' then return; end if;
  if v_lease.expires_at <= v_now then
    update public.cv_byok_leases set state = 'expired', elapsed_seconds = reserved_seconds,
      finished_at = expires_at where id = p_lease_id;
    return;
  end if;

  v_actual := least(v_lease.reserved_seconds, p_elapsed_seconds);
  update public.cv_byok_global_days
    set used_seconds = greatest(0, used_seconds - (v_lease.reserved_seconds - v_actual)), updated_at = v_now
    where usage_date = v_lease.usage_date;
  update public.cv_byok_key_days
    set used_seconds = greatest(0, used_seconds - (v_lease.reserved_seconds - v_actual)), updated_at = v_now
    where usage_date = v_lease.usage_date and fingerprint = v_lease.fingerprint;
  -- Connection-attempt counters are intentionally never refunded, including
  -- provider rejection, startup failure, and normal zero-second disconnects.
  update public.cv_byok_leases set state = 'finished', elapsed_seconds = v_actual,
    finished_at = v_now where id = p_lease_id;
end;
$$;

revoke all on function public.cv_byok_reserve_session(text, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.cv_byok_finish_session(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.cv_byok_reserve_session(text, integer, integer, integer, integer)
  to service_role;
grant execute on function public.cv_byok_finish_session(uuid, integer) to service_role;

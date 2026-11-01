import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const UNKNOWN = '11111111-1111-4111-8111-111111111111';

async function rejectsSql(promise, code, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    if (message) assert.match(error.message, new RegExp(message));
    return true;
  });
}

// PGlite executes the real PostgreSQL RPCs, permissions, constraints, and
// transactions. Its one connection serializes Promise.all calls; this is not
// a simulation of separate Vercel instances racing on independent connections.
test('BYOK accounting is private and atomic, with bounded concurrency rather than daily usage caps', async suite => {
  const db = new PGlite();
  suite.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  const schema = await readFile(new URL('../supabase/byok.sql', import.meta.url), 'utf8');
  await db.exec(schema);

  async function reset() {
    await db.exec('reset role; truncate public.cv_byok_credits, public.cv_byok_leases, public.cv_byok_key_days, public.cv_byok_global_days;');
  }
  async function reserve(fingerprint = KEY_A, limits = {}) {
    const result = await db.query('select * from public.cv_byok_reserve_session($1,$2,$3,$4,$5)', [
      fingerprint, limits.key ?? null, limits.global ?? null,
      Object.hasOwn(limits, 'session') ? limits.session : 240, limits.attempts ?? null,
    ]);
    return result.rows[0];
  }
  async function finish(lease, seconds) {
    await db.query('select public.cv_byok_finish_session($1,$2)', [lease.id, seconds]);
  }
  async function usage(fingerprint = KEY_A, offset = 0) {
    const result = await db.query(`
      select g.used_seconds as global_used, g.attempts,
        coalesce(k.used_seconds, 0) as key_used
      from public.cv_byok_global_days g
      left join public.cv_byok_key_days k on k.usage_date = g.usage_date and k.fingerprint = $1
      where g.usage_date = (clock_timestamp() at time zone 'UTC')::date + $2::integer
    `, [fingerprint, offset]);
    return result.rows[0] || { global_used: 0, attempts: 0, key_used: 0 };
  }

  await suite.test('schema is repeatable, creates no Auth schema, and contains no plaintext/key/device/chat columns', async () => {
    await reset();
    await reserve();
    await db.exec(schema);
    assert.equal((await db.query('select count(*)::integer as count from public.cv_byok_leases')).rows[0].count, 1);
    assert.equal((await db.query("select count(*)::integer as count from pg_namespace where nspname='auth'")).rows[0].count, 0);
    const columns = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name like 'cv_byok_%'");
    assert.ok(columns.rows.some(row => row.column_name === 'fingerprint'));
    assert.ok(columns.rows.every(row => !/api_key|provider_key|plaintext|mac|transcript|content|owner|user_id/.test(row.column_name)));
  });

  await suite.test('service-role reservation records both counters upfront, then refunds once without refunding attempts', async () => {
    await reset();
    await db.exec('set role service_role');
    const lease = await reserve();
    assert.equal(lease.max_seconds, 240);
    assert.deepEqual(await usage(), { global_used: 240, attempts: 1, key_used: 240 });
    await finish(lease, 23);
    assert.deepEqual(await usage(), { global_used: 23, attempts: 1, key_used: 23 });
    await finish(lease, 0);
    assert.deepEqual(await usage(), { global_used: 23, attempts: 1, key_used: 23 });
  });

  await suite.test('one active lease per fingerprint and two globally are enforced', async () => {
    await reset();
    await db.exec('set role service_role');
    const first = await reserve(KEY_A);
    await rejectsSql(reserve(KEY_A), 'P0001', 'byok_key_session_active');
    await reserve(KEY_B);
    await rejectsSql(reserve(KEY_C), 'P0001', 'byok_global_session_limit');
    assert.deepEqual(await usage(), { global_used: 480, attempts: 2, key_used: 240 });
    await finish(first, 1);
    await reserve(KEY_C);
    assert.equal((await db.query("select count(*)::integer as count from public.cv_byok_leases where state='active'")).rows[0].count, 2);
  });

  await suite.test('competing requests cannot create duplicate-key or third-global active leases', async () => {
    await reset();
    await db.exec('set role service_role');
    const sameKey = await Promise.allSettled([reserve(KEY_A), reserve(KEY_A)]);
    assert.equal(sameKey.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(sameKey.filter(result => result.status === 'rejected').length, 1);
    await reset();
    await db.exec('set role service_role');
    const differentKeys = await Promise.allSettled([reserve(KEY_A), reserve(KEY_B), reserve(KEY_C)]);
    assert.equal(differentKeys.filter(result => result.status === 'fulfilled').length, 2);
    assert.equal(differentKeys.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await db.query("select count(*)::integer as count from public.cv_byok_leases where state='active'")).rows[0].count, 2);
  });

  await suite.test('the full requested session remains available past the former key and global daily caps', async () => {
    await reset();
    await db.exec('set role service_role');
    for (const expected of [240, 240, 240, 240, 240, 240]) {
      const lease = await reserve();
      assert.equal(lease.max_seconds, expected);
      await finish(lease, expected);
    }
    assert.deepEqual(await usage(), { global_used: 1440, attempts: 6, key_used: 1440 });
    assert.equal((await reserve(KEY_B)).max_seconds, 240);
  });

  await suite.test('legacy daily and attempt arguments are ignored, including null and formerly invalid values', async () => {
    await reset();
    await db.exec('set role service_role');
    for (const legacy of [
      { key: null, global: null, attempts: null },
      { key: 1, global: 1, attempts: 1 },
      { key: 0, global: 0, attempts: 0 },
      { key: -1, global: -1, attempts: -1 },
      { key: 601, global: 1201, attempts: 101 },
    ]) {
      const lease = await reserve(KEY_A, legacy);
      assert.equal(lease.max_seconds, 240);
      await finish(lease, 240);
    }
    const short = await reserve(KEY_A, { session: 17, key: 1, global: 1, attempts: 1 });
    assert.equal(short.max_seconds, 17);
    await finish(short, 86400);
    assert.deepEqual(await usage(), { global_used: 1217, attempts: 6, key_used: 1217 });
  });

  await suite.test('more than 100 zero-second startup reservations retain statistics without blocking later sessions', async () => {
    await reset();
    await db.exec('set role service_role');
    for (let i = 0; i < 105; i += 1) {
      const fingerprint = createHash('sha256').update(`invalid-test-key-${i}`).digest('hex');
      const lease = await reserve(fingerprint);
      await finish(lease, 0);
    }
    const next = await reserve(KEY_A);
    assert.equal(next.max_seconds, 240);
    await finish(next, 0);
    assert.deepEqual(await usage(), { global_used: 0, attempts: 106, key_used: 0 });
    assert.equal((await db.query('select count(*)::integer as count from public.cv_byok_leases')).rows[0].count, 106);
    assert.equal((await db.query('select count(*)::integer as count from public.cv_byok_key_days')).rows[0].count, 106);
  });

  await suite.test('upgrading an exhausted original day removes its old attempts constraint and preserves usage history', async () => {
    await reset();
    await db.exec(`
      alter table public.cv_byok_global_days drop constraint cv_byok_global_days_attempts_check;
      alter table public.cv_byok_global_days add constraint cv_byok_global_days_attempts_check
        check (attempts between 0 and 100);
      insert into public.cv_byok_global_days(usage_date,used_seconds,attempts)
        values ((clock_timestamp() at time zone 'UTC')::date,1200,100);
      insert into public.cv_byok_key_days(usage_date,fingerprint,used_seconds)
        values ((clock_timestamp() at time zone 'UTC')::date,'${KEY_A}',600);
    `);
    await db.exec(schema);
    await db.exec('set role service_role');
    const lease = await reserve(KEY_A, { key: 600, global: 1200, attempts: 100 });
    assert.equal(lease.max_seconds, 240);
    assert.deepEqual(await usage(), { global_used: 1440, attempts: 101, key_used: 840 });
    await finish(lease, 240);
    await db.exec('reset role');
    await db.exec(schema);
    assert.deepEqual(await usage(), { global_used: 1440, attempts: 101, key_used: 840 });
    assert.equal((await db.query('select count(*)::integer as count from public.cv_byok_leases')).rows[0].count, 1);
  });

  await suite.test('expired/abandoned leases remain fully charged and cannot be refunded later', async () => {
    await reset();
    await db.exec('set role service_role');
    const abandoned = await reserve();
    await db.query("update public.cv_byok_leases set expires_at=clock_timestamp()-interval '1 second' where id=$1", [abandoned.id]);
    const next = await reserve();
    await finish(abandoned, 0);
    assert.deepEqual(await usage(), { global_used: 480, attempts: 2, key_used: 480 });
    await db.query("update public.cv_byok_leases set expires_at=clock_timestamp()-interval '1 second' where id=$1", [next.id]);
    await finish(next, 0);
    assert.deepEqual(await usage(), { global_used: 480, attempts: 2, key_used: 480 });
    const states = await db.query('select distinct state from public.cv_byok_leases');
    assert.deepEqual(states.rows, [{ state: 'expired' }]);
  });

  await suite.test('midnight settlement refunds the original UTC day, and active keys span dates', async () => {
    await reset();
    await db.exec('set role service_role');
    const lease = await reserve();
    await db.exec(`
      insert into public.cv_byok_global_days(usage_date,used_seconds,attempts)
        values ((clock_timestamp() at time zone 'UTC')::date-1,240,1);
      insert into public.cv_byok_key_days(usage_date,fingerprint,used_seconds)
        values ((clock_timestamp() at time zone 'UTC')::date-1,'${KEY_A}',240);
    `);
    await db.query("update public.cv_byok_leases set usage_date=(clock_timestamp() at time zone 'UTC')::date-1 where id=$1", [lease.id]);
    await db.exec(`
      update public.cv_byok_global_days set used_seconds=17,attempts=5
        where usage_date=(clock_timestamp() at time zone 'UTC')::date;
      update public.cv_byok_key_days set used_seconds=17
        where usage_date=(clock_timestamp() at time zone 'UTC')::date;
    `);
    await rejectsSql(reserve(), 'P0001', 'byok_key_session_active');
    await finish(lease, 13);
    assert.deepEqual(await usage(), { global_used: 17, attempts: 5, key_used: 17 });
    assert.deepEqual(await usage(KEY_A, -1), { global_used: 13, attempts: 1, key_used: 13 });
    await reserve();
    assert.equal((await usage()).global_used, 257);
  });

  await suite.test('old counters, fingerprints, and leases are lazily removed after seven days', async () => {
    await reset();
    await db.exec('set role service_role');
    await db.exec(`
      insert into public.cv_byok_global_days(usage_date,used_seconds,attempts)
        values ((clock_timestamp() at time zone 'UTC')::date-8,1,1);
      insert into public.cv_byok_key_days(usage_date,fingerprint,used_seconds)
        values ((clock_timestamp() at time zone 'UTC')::date-8,'${KEY_B}',1);
      insert into public.cv_byok_leases(fingerprint,usage_date,reserved_seconds,created_at,expires_at)
        values ('${KEY_B}',(clock_timestamp() at time zone 'UTC')::date-8,1,
                clock_timestamp()-interval '8 days',clock_timestamp()-interval '8 days'+interval '31 seconds');
    `);
    await reserve();
    for (const table of ['cv_byok_global_days', 'cv_byok_key_days', 'cv_byok_leases']) {
      assert.equal((await db.query(`select count(*)::integer as count from public.${table}`)).rows[0].count, 1);
    }
  });

  await suite.test('invalid session limits/fingerprints/elapsed durations are rejected without allowing inflated refunds', async () => {
    await reset();
    await db.exec('set role service_role');
    for (const limits of [{ session: 241 }, { session: 0 }, { session: -1 }, { session: null }]) {
      await rejectsSql(reserve(KEY_A, limits), 'P0001', 'byok_invalid_limits');
    }
    await rejectsSql(reserve('raw-provider-key'), 'P0001', 'byok_invalid_fingerprint');
    const lease = await reserve();
    await rejectsSql(db.query('update public.cv_byok_global_days set attempts=-1'), '23514');
    await rejectsSql(finish(lease, -1), 'P0001', 'byok_invalid_elapsed');
    await rejectsSql(finish(lease, null), 'P0001', 'byok_invalid_elapsed');
    await rejectsSql(finish({ id: UNKNOWN }, 0), 'P0001', 'byok_lease_not_found');
    await finish(lease, 86400);
    assert.deepEqual(await usage(), { global_used: 240, attempts: 1, key_used: 240 });
  });

  await suite.test('anonymous/authenticated roles have no table or RPC access, with RLS as defense in depth', async () => {
    await reset();
    await reserve();
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      for (const table of ['cv_byok_global_days', 'cv_byok_key_days', 'cv_byok_leases', 'cv_byok_credits']) {
        await rejectsSql(db.query(`select * from public.${table}`), '42501');
        await rejectsSql(db.query(`delete from public.${table}`), '42501');
      }
      await rejectsSql(reserve(), '42501');
      await rejectsSql(finish({ id: UNKNOWN }, 0), '42501');
      await rejectsSql(db.query(`insert into public.cv_byok_credits
        (credit_key, usage_date, fingerprint, seconds_credited, reason)
        values ('visitor-credit', current_date, '${KEY_A}', 600, 'not authorized')`), '42501');
      await db.exec('reset role');
    }
    await db.exec('grant select on public.cv_byok_leases to authenticated; set role authenticated;');
    assert.equal((await db.query('select count(*)::integer as count from public.cv_byok_leases')).rows[0].count, 0);
    await db.exec('reset role; revoke select on public.cv_byok_leases from authenticated;');
    const functions = await db.query("select prosecdef from pg_proc where proname in ('cv_byok_reserve_session','cv_byok_finish_session')");
    assert.equal(functions.rows.length, 2);
    assert.ok(functions.rows.every(row => row.prosecdef === false));
  });

  await suite.test('operator recovery credits have a unique incident key and retain original leases', async () => {
    await reset();
    await db.exec('set role service_role');
    const lease = await reserve();
    await finish(lease, 20);
    const insert = () => db.query(`insert into public.cv_byok_credits
      (credit_key, usage_date, fingerprint, seconds_credited, reason)
      values ('diagnostic-recovery', (clock_timestamp() at time zone 'UTC')::date, $1, 20, 'failed transport test')`, [KEY_A]);
    await insert();
    await rejectsSql(insert(), '23505');
    assert.equal((await db.query('select count(*)::integer as count from public.cv_byok_leases')).rows[0].count, 1);
    assert.equal((await db.query('select seconds_credited from public.cv_byok_credits')).rows[0].seconds_credited, 20);
  });
});

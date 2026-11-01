import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const OTHER_DEVICE = '44444444-4444-4444-8444-444444444444';
const NEW_DEVICE = '55555555-5555-4555-8555-555555555555';

async function rejectsSql(promise, expectedCode, expectedMessage) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode);
    if (expectedMessage) assert.match(error.message, new RegExp(expectedMessage));
    return true;
  });
}

// PGlite executes the actual PostgreSQL schema and PL/pgSQL RPC bodies. It has
// one connection, so these tests exercise real constraints and transaction
// semantics, but cannot simulate two independent database connections racing.
test('fresh private schema enforces PostgreSQL permissions and voice accounting', async (suite) => {
  const db = new PGlite();
  suite.after(async () => { await db.close(); });
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text not null);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    insert into auth.users values
      ('${OWNER}', 'owner@example.test'), ('${OTHER}', 'other@example.test');
  `);
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);

  async function resetData() {
    await db.exec(`
      reset role;
      truncate public.cv_messages, public.cv_voice_leases, public.cv_usage,
        public.cv_devices, public.cv_settings;
      insert into public.cv_settings(owner_id, character_name)
        values ('${OWNER}', 'Owner character'), ('${OTHER}', 'Other character');
      insert into public.cv_devices(id, owner_id, name, mac, token_hash) values
        ('${DEVICE}', '${OWNER}', 'Owner Cardputer', 'AA:BB:CC:DD:EE:01', repeat('a', 64)),
        ('${OTHER_DEVICE}', '${OTHER}', 'Other Cardputer', 'AA:BB:CC:DD:EE:02', repeat('b', 64));
    `);
  }

  async function reserve(daily = 600, session = 240, owner = OWNER, device = DEVICE) {
    const result = await db.query('select * from public.cv_reserve_session($1, $2, $3, $4)', [owner, device, daily, session]);
    return result.rows[0];
  }

  async function finish(lease, elapsed) {
    await db.query('select public.cv_finish_session($1, $2)', [lease.id, elapsed]);
  }

  async function used(owner = OWNER) {
    const result = await db.query('select used_seconds from public.cv_usage where owner_id = $1 and usage_date = (clock_timestamp() at time zone \'UTC\')::date', [owner]);
    return result.rows[0]?.used_seconds ?? 0;
  }

  await suite.test('schema can be applied twice without changing permissions or losing data', async () => {
    await resetData();
    await db.exec(schema);
    const result = await db.query('select count(*)::integer as count from public.cv_devices');
    assert.equal(result.rows[0].count, 2);
  });

  await suite.test('service role reserves upfront and settlement refunds exactly once', async () => {
    await resetData();
    await db.exec('set role service_role');
    const lease = await reserve();
    assert.equal(lease.max_seconds, 240);
    assert.equal(await used(), 240);
    await finish(lease, 23);
    assert.equal(await used(), 23);
    await finish(lease, 0);
    assert.equal(await used(), 23);
    const record = await db.query('select state, elapsed_seconds from public.cv_voice_leases where id = $1', [lease.id]);
    assert.deepEqual(record.rows[0], { state: 'finished', elapsed_seconds: 23 });
  });

  await suite.test('another active session is rejected without a second charge', async () => {
    await resetData();
    await db.exec('set role service_role');
    await reserve();
    await rejectsSql(reserve(), 'P0001', 'voice_session_active');
    assert.equal(await used(), 240);
    const result = await db.query("select count(*)::integer as count from public.cv_voice_leases where owner_id = $1 and state = 'active'", [OWNER]);
    assert.equal(result.rows[0].count, 1);
  });

  await suite.test('partial remaining allowance is reserved and the daily cap cannot be exceeded', async () => {
    await resetData();
    await db.exec('set role service_role');
    const lease = await reserve(60, 240);
    assert.equal(lease.max_seconds, 60);
    assert.equal(await used(), 60);
    await finish(lease, 200);
    assert.equal(await used(), 60);
    await rejectsSql(reserve(60, 240), 'P0001', 'daily_voice_limit');
    assert.equal(await used(), 60);
  });

  await suite.test('abandoned or expired sessions consume their reservation and cannot be refunded later', async () => {
    await resetData();
    await db.exec('set role service_role');
    const abandoned = await reserve();
    await db.query("update public.cv_voice_leases set expires_at = clock_timestamp() - interval '1 second' where id = $1", [abandoned.id]);
    const next = await reserve();
    assert.equal(await used(), 480);
    const oldLease = await db.query('select state, elapsed_seconds from public.cv_voice_leases where id = $1', [abandoned.id]);
    assert.deepEqual(oldLease.rows[0], { state: 'expired', elapsed_seconds: 240 });
    await finish(abandoned, 0);
    assert.equal(await used(), 480);
    await finish(next, 20);
    assert.equal(await used(), 260);
  });

  await suite.test('a settlement after midnight refunds its original UTC date and an old active lease blocks a new day', async () => {
    await resetData();
    await db.exec('set role service_role');
    const lease = await reserve();
    await db.query(`
      insert into public.cv_usage(owner_id, usage_date, used_seconds)
        values ($1, (clock_timestamp() at time zone 'UTC')::date - 1, 240)
    `, [OWNER]);
    await db.query(`
      update public.cv_voice_leases set usage_date = (clock_timestamp() at time zone 'UTC')::date - 1
        where id = $1
    `, [lease.id]);
    await db.query(`
      update public.cv_usage set used_seconds = 17
        where owner_id = $1 and usage_date = (clock_timestamp() at time zone 'UTC')::date
    `, [OWNER]);
    await rejectsSql(reserve(), 'P0001', 'voice_session_active');
    await finish(lease, 13);
    assert.equal(await used(), 17);
    const yesterday = await db.query(`
      select used_seconds from public.cv_usage
        where owner_id = $1 and usage_date = (clock_timestamp() at time zone 'UTC')::date - 1
    `, [OWNER]);
    assert.equal(yesterday.rows[0].used_seconds, 13);
    await reserve();
    assert.equal(await used(), 257);
  });

  await suite.test('RPCs reject disabled devices, cross-owner IDs, and out-of-range configured limits', async () => {
    await resetData();
    await db.exec('set role service_role');
    await rejectsSql(reserve(600, 240, OTHER, DEVICE), 'P0001', 'device_unavailable');
    for (const [daily, session] of [[59, 240], [1801, 240], [600, 19], [600, 241]]) {
      await rejectsSql(reserve(daily, session), 'P0001', 'invalid_voice_limits');
    }
    await db.query('update public.cv_devices set enabled = false where id = $1', [DEVICE]);
    await rejectsSql(reserve(), 'P0001', 'device_unavailable');
    assert.equal(await used(), 0);
  });

  await suite.test('unique partial indexes prevent a second enabled device and reuse of an enabled MAC', async () => {
    await resetData();
    await db.exec('set role service_role');
    await rejectsSql(db.query(`
      insert into public.cv_devices(id, owner_id, name, mac, token_hash)
      values ($1, $2, 'Second device', 'AA:BB:CC:DD:EE:03', repeat('c', 64))
    `, [NEW_DEVICE, OWNER]), '23505', 'cv_one_enabled_device_per_owner');
    await db.query('update public.cv_devices set enabled = false where id = $1', [DEVICE]);
    await rejectsSql(db.query(`
      insert into public.cv_devices(id, owner_id, name, mac, token_hash)
      values ($1, $2, 'MAC collision', 'AA:BB:CC:DD:EE:02', repeat('c', 64))
    `, [NEW_DEVICE, OWNER]), '23505', 'cv_one_enabled_device_per_mac');
    await db.query(`
      insert into public.cv_devices(id, owner_id, name, mac, token_hash)
      values ($1, $2, 'Replacement device', 'AA:BB:CC:DD:EE:03', repeat('c', 64))
    `, [NEW_DEVICE, OWNER]);
    await rejectsSql(db.query('update public.cv_devices set enabled = true where id = $1', [DEVICE]), '23505');
  });

  await suite.test('authenticated users see only their own records and cannot select hashes or mutate accounting', async () => {
    await resetData();
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER]);
    await db.exec('set role authenticated');
    const settings = await db.query('select owner_id, character_name from public.cv_settings');
    assert.deepEqual(settings.rows, [{ owner_id: OWNER, character_name: 'Owner character' }]);
    const devices = await db.query('select id, owner_id, mac from public.cv_devices');
    assert.equal(devices.rows.length, 1);
    assert.equal(devices.rows[0].id, DEVICE);
    await rejectsSql(db.query('select token_hash from public.cv_devices'), '42501');
    await rejectsSql(db.query('update public.cv_devices set token_hash = repeat(\'z\', 64) where id = $1', [DEVICE]), '42501');
    await rejectsSql(db.query('insert into public.cv_usage(owner_id, usage_date, used_seconds) values ($1, current_date, 0)', [OWNER]), '42501');
    await rejectsSql(db.query('update public.cv_usage set used_seconds = 0'), '42501');
  });

  await suite.test('anonymous and authenticated roles cannot call privileged RPCs', async () => {
    await resetData();
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await rejectsSql(reserve(), '42501');
      await rejectsSql(db.query('select public.cv_finish_session($1, 0)', [NEW_DEVICE]), '42501');
      await rejectsSql(db.query("select public.cv_append_transcript($1, $2, 'user', 'Hello')", [OWNER, DEVICE]), '42501');
      await db.exec('reset role');
    }
    await db.exec('set role anon');
    await rejectsSql(db.query('select owner_id from public.cv_settings'), '42501');
    await rejectsSql(db.query('select id from public.cv_devices'), '42501');
  });

  await suite.test('transcript history is capped per owner and cross-owner writes fail', async () => {
    await resetData();
    await db.exec('set role service_role');
    await db.query("select public.cv_append_transcript($1, $2, 'assistant', 'Other owner message')", [OTHER, OTHER_DEVICE]);
    // Explicit historical timestamps avoid ties caused by the WASM host clock's
    // millisecond resolution, while the real RPC performs insertion + pruning.
    await db.query(`
      insert into public.cv_messages(owner_id, device_id, role, content, created_at)
      select $1, $2, 'user', 'Message ' || n::text,
        clock_timestamp() - interval '1 hour' + n * interval '1 millisecond'
        from generate_series(1, 204) n
    `, [OWNER, DEVICE]);
    await db.query("select public.cv_append_transcript($1, $2, 'user', 'Message 205')", [OWNER, DEVICE]);
    const counts = await db.query('select owner_id, count(*)::integer as count from public.cv_messages group by owner_id order by owner_id');
    assert.deepEqual(counts.rows, [{ owner_id: OWNER, count: 200 }, { owner_id: OTHER, count: 1 }]);
    const oldest = await db.query('select content from public.cv_messages where owner_id = $1 order by created_at, id limit 1', [OWNER]);
    assert.equal(oldest.rows[0].content, 'Message 6');
    await rejectsSql(db.query("select public.cv_append_transcript($1, $2, 'assistant', 'Wrong owner')", [OTHER, DEVICE]), 'P0001', 'device_unavailable');
    await rejectsSql(db.query("select public.cv_append_transcript($1, $2, 'system', 'Wrong role')", [OWNER, DEVICE]), 'P0001', 'invalid_transcript');
  });
});

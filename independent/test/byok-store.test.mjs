import test from 'node:test';
import assert from 'node:assert/strict';
import { createByokStore, BYOK_LIMITS } from '../src/byok-store.mjs';
import { StoreError } from '../src/store.mjs';

const FINGERPRINT = 'a'.repeat(64);
const LEASE = '11111111-1111-4111-8111-111111111111';
const CONFIG = {
  supabaseUrl: 'https://accounting.example.supabase.co',
  supabaseServiceRoleKey: 'sb_secret_test_only',
  sessionSeconds: 240,
};

function fixture(handler, config = CONFIG) {
  const calls = [];
  const store = createByokStore(config, { fetchImpl: async (input, options) => {
    const call = { url: new URL(input), ...options, json: JSON.parse(options.body) };
    calls.push(call);
    const data = await handler(call);
    return data instanceof Response ? data : Response.json(data);
  } });
  return { store, calls };
}

function rejectsStatus(promise, status) {
  return assert.rejects(promise, error => error instanceof StoreError && error.status === status);
}

test('BYOK reservations send a fingerprint and session duration without daily caps', async () => {
  const { store, calls } = fixture(call => {
    assert.equal(call.url.pathname, '/rest/v1/rpc/cv_byok_reserve_session');
    assert.deepEqual(call.json, {
      p_fingerprint: FINGERPRINT,
      p_key_daily_seconds: null,
      p_global_daily_seconds: null,
      p_session_seconds: 240,
      p_max_attempts: null,
    });
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.apikey, CONFIG.supabaseServiceRoleKey);
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
    return [{ id: LEASE, max_seconds: 240 }];
  });
  assert.deepEqual(await store.reserveSession(FINGERPRINT), { id: LEASE, maxSeconds: 240 });
  assert.equal(calls.length, 1);
  assert.deepEqual(BYOK_LIMITS, {
    maxSessionSeconds: 240, maxActiveSessions: 2,
  });
});

test('private-owner daily settings do not impose a budget on BYOK', async () => {
  const { store } = fixture(call => {
    assert.equal(call.json.p_key_daily_seconds, null);
    assert.equal(call.json.p_global_daily_seconds, null);
    assert.equal(call.json.p_max_attempts, null);
    assert.equal(call.json.p_session_seconds, 45);
    return [{ id: LEASE, max_seconds: 45 }];
  }, { ...CONFIG, ownerEmail: '', dailyVoiceSeconds: 1, globalAttempts: 1, sessionSeconds: 45 });
  assert.deepEqual(await store.reserveSession(FINGERPRINT), { id: LEASE, maxSeconds: 45 });
});

test('legacy Supabase service JWTs retain their bearer header and settlement rounds seconds upward', async () => {
  const legacy = { ...CONFIG, supabaseServiceRoleKey: 'legacy-test-service-role-jwt' };
  const { store, calls } = fixture(call => {
    assert.equal(call.url.pathname, '/rest/v1/rpc/cv_byok_finish_session');
    assert.equal(call.headers.Authorization, `Bearer ${legacy.supabaseServiceRoleKey}`);
    assert.deepEqual(call.json, { p_lease_id: LEASE, p_elapsed_seconds: 4 });
    return null;
  }, legacy);
  await store.finishSession(LEASE, 3.1);
  assert.equal(calls.length, 1);
});

test('raw provider keys, MAC addresses, invalid IDs, and invalid elapsed times never reach the database', async () => {
  const { store, calls } = fixture(() => assert.fail('No network request expected'));
  for (const value of ['AIza-fake-provider-key', 'AA:BB:CC:DD:EE:FF', 'gemini:raw-key', '', null, 'A'.repeat(64)]) {
    await rejectsStatus(store.reserveSession(value), 400);
  }
  await rejectsStatus(store.finishSession('not-a-lease', 0), 400);
  for (const value of [-1, NaN, Infinity, 86401, '5', null]) {
    await rejectsStatus(store.finishSession(LEASE, value), 400);
  }
  assert.equal(calls.length, 0);
});

test('missing, unsafe, and excessive service configuration fails closed before HTTP', async () => {
  for (const change of [
    { supabaseUrl: '' }, { supabaseServiceRoleKey: '' },
    { supabaseUrl: 'http://public.example.com' },
    { supabaseUrl: 'https://user:password@example.com' },
    { supabaseUrl: 'https://example.com/path' },
    { supabaseUrl: 'https://example.com/?credential=private' },
    { sessionSeconds: 241 }, { sessionSeconds: 0 }, { sessionSeconds: '240' },
  ]) {
    const { store, calls } = fixture(() => assert.fail('No HTTP expected'), { ...CONFIG, ...change });
    await rejectsStatus(store.reserveSession(FINGERPRINT), 503);
    assert.equal(calls.length, 0);
  }
});

test('concurrency and configuration errors have distinct safe public statuses', async () => {
  for (const [message, status] of [
    ['byok_key_session_active', 409],
    ['byok_global_session_limit', 429], ['byok_invalid_limits', 503],
  ]) {
    const { store } = fixture(() => Response.json({ message, details: 'private upstream contents' }, { status: 400 }));
    await rejectsStatus(store.reserveSession(FINGERPRINT), status);
  }
  const { store } = fixture(() => Response.json({ message: 'byok_lease_not_found' }, { status: 400 }));
  await rejectsStatus(store.finishSession(LEASE, 0), 404);
});

test('unexpected upstream bodies and network failures never expose credentials or provider content', async () => {
  for (const message of ['constructor', '__proto__', 'sb_secret_test_only private raw-provider-key']) {
    const { store } = fixture(() => Response.json({ message }, { status: 500 }));
    await assert.rejects(store.reserveSession(FINGERPRINT), error => {
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /sb_secret|raw-provider|constructor|__proto__/);
      return true;
    });
  }
  const network = fixture(() => { throw new Error('sb_secret_test_only must not leak'); });
  await assert.rejects(network.store.reserveSession(FINGERPRINT), error => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /sb_secret/);
    return true;
  });
});

test('malformed reservation responses cannot increase or invent a lease', async () => {
  for (const response of [
    [], [{ id: 'invalid', max_seconds: 30 }], [{ id: LEASE, max_seconds: 0 }],
    [{ id: LEASE, max_seconds: 241 }], [{ id: LEASE, max_seconds: 4.5 }],
    [{ id: LEASE, max_seconds: 1 }, { id: LEASE, max_seconds: 1 }],
  ]) {
    const { store } = fixture(() => response);
    await rejectsStatus(store.reserveSession(FINGERPRINT), 502);
  }
});

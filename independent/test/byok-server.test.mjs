import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createAppServer } from '../src/server.mjs';
import { StoreError } from '../src/store.mjs';

const fakeKey = 'test-only-personal-provider-key-12345';
const headers = { Authorization: `Bearer ${fakeKey}`, 'X-Voice-Provider': 'gemini' };
const config = {
  configured: true, appOrigin: 'http://localhost', appName: 'Voice',
  geminiApiKey: 'private-host-key-must-never-be-a-fallback',
  model: 'gemini-2.5-flash-native-audio-preview-12-2025', sessionSeconds: 240,
};

async function fixture(t, overrides = {}) {
  const calls = { private: 0, reservations: [], settlements: [], voice: [] };
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  const store = {
    async authenticateDevice() { calls.private++; throw new StoreError(401, 'Invalid device.'); },
    async authenticateOwner() { throw new StoreError(401, 'Sign in.'); },
  };
  const byokStore = {
    async reserveSession(fingerprint) {
      calls.reservations.push(fingerprint);
      return { id: '11111111-1111-4111-8111-111111111111', maxSeconds: 100 };
    },
    async finishSession(id, elapsed) { calls.settlements.push({ id, elapsed }); resolveSettled(); },
    ...overrides.byokStore,
  };
  const voiceFactory = async options => {
    calls.voice.push(options);
    options.deviceSocket.send(JSON.stringify({ type: 'auth', volume_control: 70 }));
    // A visitor's chats must never be written into the private owner's history.
    await options.onTranscript({ role: 'user', content: 'Visitor speech' });
    return { close() { options.deviceSocket.close(); return options.onEnd({ elapsedSeconds: 1 }); } };
  };
  const server = createAppServer({ config, store, byokStore, voiceFactory, waitUntil: overrides.waitUntil });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeVoiceSessions();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `ws://127.0.0.1:${server.address().port}`;
  return { base, calls, settled };
}

test('a BYOK visitor needs no owner account and uses only their supplied key', async t => {
  const { base, calls, settled } = await fixture(t);
  const ws = new WebSocket(`${base}/ws/byok`, { headers });
  const message = once(ws, 'message');
  await once(ws, 'open');
  assert.equal(JSON.parse(String((await message)[0])).type, 'auth');
  assert.equal(calls.private, 0);
  assert.equal(calls.voice[0].apiKey, fakeKey);
  assert.equal(calls.voice[0].provider, 'gemini');
  assert.equal(calls.voice[0].maxSeconds, 100);
  assert.match(calls.reservations[0], /^[a-f0-9]{64}$/);
  ws.close();
  await settled;
  assert.equal(calls.settlements.length, 1);
});

test('ElevenLabs and Hume use the selected existing agent/config ID', async t => {
  for (const provider of ['elevenlabs', 'hume']) {
    const { base, calls } = await fixture(t);
    const ws = new WebSocket(`${base}/api/index?route=voice-byok`, { headers: {
      ...headers, 'X-Voice-Provider': provider, 'X-Voice-Reference': 'configured_agent_123',
    } });
    await once(ws, 'message');
    assert.equal(calls.voice[0].provider, provider);
    assert.equal(calls.voice[0].referenceId, 'configured_agent_123');
    ws.close();
    await once(ws, 'close');
  }
});

test('missing provider keys are rejected before any reservation or private-key fallback', async t => {
  const { base, calls } = await fixture(t);
  const ws = new WebSocket(`${base}/ws/byok`, { headers: { 'X-Voice-Provider': 'gemini' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /401/);
  assert.equal(calls.reservations.length, 0);
  assert.equal(calls.voice.length, 0);
  assert.equal(calls.private, 0);
});

test('occupied shared capacity fails before contacting a provider', async t => {
  const { base, calls } = await fixture(t, { byokStore: {
    async reserveSession() { throw new StoreError(429, 'Both voice sessions are busy. Try again shortly.'); },
  } });
  const ws = new WebSocket(`${base}/ws/byok`, { headers });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /429/);
  assert.equal(calls.voice.length, 0);
});

test('BYOK settlement is covered by the Vercel upgrade lifecycle', async t => {
  const lifecycles = [];
  const { base, settled } = await fixture(t, { waitUntil: promise => lifecycles.push(promise) });
  const ws = new WebSocket(`${base}/ws/byok`, { headers });
  await once(ws, 'message');
  ws.close();
  await settled;
  await Promise.all(lifecycles);
  assert.equal(lifecycles.length, 1);
});

test('a rejected BYOK reservation completes the upgrade lifecycle without sending a sleep instruction', async t => {
  const lifecycles = [];
  const { base, calls } = await fixture(t, {
    waitUntil: promise => lifecycles.push(promise),
    byokStore: { async reserveSession() { throw new StoreError(409, 'This provider key is already in use.'); } },
  });
  const ws = new WebSocket(`${base}/ws/byok`, { headers });
  ws.on('message', () => assert.fail('A busy connection must not send SESSION.END.'));
  const [error] = await once(ws, 'error');
  assert.match(error.message, /409/);
  await Promise.all(lifecycles);
  assert.equal(calls.voice.length, 0);
  assert.equal(calls.settlements.length, 0);
});

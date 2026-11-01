import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pairDevice, listPairedDevices, forgetDevice, createWirelessSetup } from '../public/wireless-setup.js';

const RAW_SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const CONTROL_SECRET = RAW_SECRET.toString('base64url');
const API_KEY = 'fixture_provider_key_0123456789';
const DEVICE = { type: 'paired', id: 'usb-pair-request', deviceId: '001122AABBCC',
  host: 'cardputer-aabbcc.local', port: 8080, ip: '192.168.1.51', controlSecret: CONTROL_SECRET };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const derive = (direction, secret = RAW_SECRET) => createHash('sha256')
  .update(secret).update(`CardputerVoice wireless ${direction} v1`).digest();

class MemoryStore {
  records = new Map();
  writes = [];
  async put(record) { this.writes.push(structuredClone(record)); this.records.set(record.deviceId, structuredClone(record)); }
  async get(id) { return this.records.has(id) ? structuredClone(this.records.get(id)) : undefined; }
  async list() { return [...this.records.values()].map((record) => structuredClone(record)); }
  async delete(id) { this.records.delete(id); }
}

class FakeClock {
  time = 0;
  next = 1;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, ms) => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  advance(ms) {
    const end = this.time + ms;
    while (true) {
      const first = [...this.timers.entries()].filter(([, entry]) => entry.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.time = first[1].at;
      this.timers.delete(first[0]);
      first[1].callback();
    }
    this.time = end;
  }
}

async function until(predicate) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('Expected mocked wireless state was not reached');
}

class FakeLanDevice {
  calls = [];
  commands = [];
  envelopes = [];
  challenges = 0;
  operationId;
  constructor(options = {}) { this.options = options; }
  fetch = async (url, options) => {
    this.calls.push({ url, options });
    if (this.options.fetchError) return this.options.fetchError(url, options);
    const target = new URL(url);
    if (this.options.mdnsFails && target.hostname.endsWith('.local')) throw new TypeError(API_KEY);
    if (target.pathname === '/setup/challenge') {
      const bytes = Buffer.alloc(16, 0x31);
      bytes.writeUInt32BE(++this.challenges, 12);
      return Response.json({ protocol: 1, deviceId: this.options.wrongDevice || DEVICE.deviceId,
        challenge: this.options.challenge || bytes.toString('base64url'), expiresIn: 15 });
    }
    assert.equal(target.pathname, '/setup/command');
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    this.envelopes.push(request);
    const aad = (direction) => Buffer.from(`CVWIFI1|${direction}|${request.deviceId}|${request.challenge}|${request.id}`);
    const encoded = Buffer.from(request.ciphertext, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', derive('request'), Buffer.from(request.iv, 'base64url'));
    decipher.setAAD(aad('request'));
    decipher.setAuthTag(encoded.subarray(-16));
    const command = JSON.parse(Buffer.concat([decipher.update(encoded.subarray(0, -16)), decipher.final()]).toString('utf8'));
    this.commands.push(command);
    let plain;
    if (command.type === 'open_setup') plain = { type: this.options.setupState || 'setup_open', id: request.id };
    else if (command.type === 'configure') {
      this.operationId = request.id;
      plain = { type: this.options.immediateSaved ? 'saved' : 'pending', id: request.id, operationId: request.id };
    } else {
      assert.equal(command.type, 'status');
      assert.equal(command.operationId, this.operationId);
      plain = { type: this.options.alwaysPending ? 'pending' : 'saved', id: request.id, operationId: command.operationId };
    }
    if (this.options.plainMutator) plain = this.options.plainMutator(plain, command, request);
    if (this.options.unencrypted) return Response.json(plain);
    if (this.options.replayResponse) return Response.json(this.options.replayResponse);
    const responseIv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.options.wrongResponseKey ? Buffer.alloc(32, 0x91) : derive('response'), responseIv);
    cipher.setAAD(aad('response'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plain)), cipher.final(), cipher.getAuthTag()]);
    let response = { protocol: 1, deviceId: DEVICE.deviceId, id: request.id,
      challenge: request.challenge, iv: responseIv.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
    if (this.options.envelopeMutator) response = this.options.envelopeMutator(response, request);
    this.lastResponse = response;
    return Response.json(response);
  };
}

async function fixture(lanOptions = {}, controllerOptions = {}) {
  const storage = new MemoryStore();
  const device = await pairDevice({ ...DEVICE }, { storage, crypto: webcrypto });
  const lan = new FakeLanDevice(lanOptions);
  const clock = new FakeClock();
  const statuses = [];
  const saved = [];
  const controller = createWirelessSetup({ device, crypto: webcrypto, storage, fetchImpl: lan.fetch, clock,
    onStatus: (status) => statuses.push(status), onSaved: (value) => saved.push(value), ...controllerOptions });
  return { device, storage, lan, clock, statuses, saved, controller };
}

test('pairing stores only nonextractable AES256 directional CryptoKeys and local metadata', async () => {
  const storage = new MemoryStore();
  const device = await pairDevice({ ...DEVICE, apiKey: API_KEY, unexpected: 'must not persist' }, { storage, crypto: webcrypto });
  assert.deepEqual(device, { deviceId: DEVICE.deviceId, host: DEVICE.host, port: 8080, ip: DEVICE.ip });
  const record = await storage.get(DEVICE.deviceId);
  assert.deepEqual(Object.keys(record).sort(), ['deviceId', 'host', 'ip', 'requestKey', 'responseKey']);
  for (const [name, usage] of [['requestKey', 'encrypt'], ['responseKey', 'decrypt']]) {
    assert.equal(record[name].extractable, false);
    assert.deepEqual(record[name].algorithm, { name: 'AES-GCM', length: 256 });
    assert.deepEqual(record[name].usages, [usage]);
    await assert.rejects(webcrypto.subtle.exportKey('raw', record[name]), { name: 'InvalidAccessError' });
  }
  assert.doesNotMatch(JSON.stringify(storage.writes), new RegExp(`${CONTROL_SECRET}|${API_KEY}|must not persist`));
  const listed = await listPairedDevices({ storage });
  assert.deepEqual(listed, [device]);
  assert.equal(Object.hasOwn(listed[0], 'requestKey'), false);
  assert.equal(Object.hasOwn(listed[0], 'controlSecret'), false);
});

test('actual WebCrypto request matches the independently derived firmware AES-GCM golden vector', async () => {
  assert.equal(derive('request').toString('hex'), '6bdbde33be74db08983d2fa1e02cdb5476534ec3eb5c3a194af8b82227dc7758');
  assert.equal(derive('response').toString('hex'), '059736a789af187149a3a03808846258a16d9a342e34ba79339cbe8152e5a00f');
  const values = [Buffer.from('00112233445566778899aabb', 'hex'), Buffer.from('202122232425262728292a2b', 'hex')];
  const crypto = { subtle: webcrypto.subtle, getRandomValues(array) { array.set(values.shift()); return array; } };
  const h = await fixture({ challenge: 'EBESExQVFhcYGRobHB0eHw' }, { crypto });
  assert.equal(h.lan.calls.length, 0, 'constructing a controller never contacts the local network');
  assert.deepEqual(await h.controller.openSetup(), { state: 'setup_open' });
  assert.deepEqual(h.lan.envelopes[0], {
    protocol: 1, deviceId: '001122AABBCC', id: '00112233445566778899aabb',
    challenge: 'EBESExQVFhcYGRobHB0eHw', iv: 'ICEiIyQlJicoKSor',
    ciphertext: 'HXKU8mQ8gB-_NXWAYZV2_c2uKK-SpufJOhtkJfy-sxGvH5jBTw',
  });
  assert.deepEqual(h.lan.commands, [{ type: 'open_setup' }]);
});

test('wireless configure uses fresh authenticated status requests and only accepts encrypted saved', async () => {
  const h = await fixture();
  const sending = h.controller.send({ provider: 'gemini', apiKey: API_KEY });
  await until(() => h.statuses.some((status) => status.code === 'confirm'));
  assert.equal(h.saved.length, 0);
  assert.deepEqual(h.lan.commands[0], { type: 'configure', provider: 'gemini', apiKey: API_KEY, referenceId: '', voice: 'Aoede' });
  h.clock.advance(1200);
  const result = await sending;
  assert.equal(result.type, 'saved');
  assert.equal(result.operationId, h.lan.operationId);
  assert.equal(result.provider, 'gemini');
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.lan.commands[1], { type: 'status', operationId: h.lan.operationId });
  assert.notEqual(h.lan.envelopes[0].id, h.lan.envelopes[1].id);
  assert.notEqual(h.lan.envelopes[0].iv, h.lan.envelopes[1].iv);
  assert.notEqual(h.lan.envelopes[0].challenge, h.lan.envelopes[1].challenge);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.controller.busy, false);
  assert.equal(h.storage.writes.length, 1, 'sending a provider key never writes it to browser storage');
  for (const call of h.lan.calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.mode, 'cors');
    assert.equal(call.options.targetAddressSpace, 'local');
    assert.equal(new URL(call.url).port, '8080');
    assert.doesNotMatch(call.url + (call.options.body || ''), new RegExp(API_KEY));
  }
  assert.doesNotMatch(JSON.stringify([h.saved, h.statuses, h.storage.writes]), new RegExp(`${API_KEY}|${CONTROL_SECRET}`));
});

test('an ordinary HTTP saved body can never claim that a key was saved', async () => {
  const h = await fixture({ unencrypted: true, immediateSaved: true });
  await assert.rejects(h.controller.send({ apiKey: API_KEY }), { code: 'authentication' });
  assert.equal(h.saved.length, 0);
  assert.equal(h.controller.busy, false);
});

test('wrong response keys, authenticated IDs, operation IDs, and modified ciphertext fail closed', async (t) => {
  const cases = [
    { name: 'wrong key', options: { wrongResponseKey: true } },
    { name: 'wrong outer id', options: { envelopeMutator: (value) => ({ ...value, id: '0'.repeat(24) }) } },
    { name: 'wrong outer device', options: { envelopeMutator: (value) => ({ ...value, deviceId: '000000000000' }) } },
    { name: 'wrong outer challenge', options: { envelopeMutator: (value) => ({ ...value, challenge: Buffer.alloc(16).toString('base64url') }) } },
    { name: 'wrong inner id', options: { plainMutator: (value) => ({ ...value, id: 'f'.repeat(24) }) } },
    { name: 'wrong operation id', options: { plainMutator: (value) => ({ ...value, operationId: 'e'.repeat(24) }) } },
    { name: 'modified cipher', options: { envelopeMutator: (value) => {
      const bytes = Buffer.from(value.ciphertext, 'base64url'); bytes[0] ^= 1;
      return { ...value, ciphertext: bytes.toString('base64url') };
    } } },
    { name: 'request reflected as response', options: { envelopeMutator: (_value, request) => request } },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const h = await fixture({ immediateSaved: true, ...item.options });
    await assert.rejects(h.controller.send({ apiKey: API_KEY }), { code: 'authentication' });
    assert.equal(h.saved.length, 0);
    assert.equal(h.lan.commands.length, 1);
    assert.equal(h.clock.timers.size, 0);
    assert.doesNotMatch(JSON.stringify(h.statuses), new RegExp(`${API_KEY}|${CONTROL_SECRET}`));
  });
});

test('the same challenge and a replayed encrypted response cannot be accepted twice', async (t) => {
  await t.test('repeated challenge', async () => {
    const h = await fixture({ challenge: Buffer.alloc(16, 2).toString('base64url') });
    await h.controller.openSetup();
    await assert.rejects(h.controller.openSetup(), { code: 'replay' });
    assert.equal(h.lan.commands.length, 1);
  });
  await t.test('prior encrypted response with a new request', async () => {
    const h = await fixture();
    await h.controller.openSetup();
    h.lan.options.replayResponse = h.lan.lastResponse;
    await assert.rejects(h.controller.openSetup(), { code: 'authentication' });
  });
});

test('mDNS is preferred, with a strict last-private-IP fallback only after user action', async () => {
  const h = await fixture({ mdnsFails: true });
  await listPairedDevices({ storage: h.storage });
  assert.equal(h.lan.calls.length, 0);
  await h.controller.openSetup();
  assert.deepEqual(h.lan.calls.map((call) => new URL(call.url).host), [
    'cardputer-aabbcc.local:8080', '192.168.1.51:8080', '192.168.1.51:8080',
  ]);
});

test('a mismatched mDNS device cannot receive credentials through an IP fallback', async () => {
  const h = await fixture({ wrongDevice: '001122FFFFFF' });
  await assert.rejects(h.controller.send({ apiKey: API_KEY }), { code: 'wrong_device' });
  assert.equal(h.lan.calls.length, 1);
  assert.equal(h.lan.commands.length, 0);
});

test('IPv4 validation permits only canonical RFC1918 addresses and ignores 0.0.0.0', async (t) => {
  for (const ip of ['10.0.0.51', '172.16.1.2', '172.31.255.254', '192.168.1.99']) {
    await t.test(`allowed ${ip}`, async () => {
      const storage = new MemoryStore();
      const value = await pairDevice({ ...DEVICE, ip }, { storage, crypto: webcrypto });
      assert.equal(value.ip, ip);
    });
  }
  for (const ip of ['8.8.8.8', '127.0.0.1', '169.254.1.2', '172.15.0.1', '172.32.0.1', '192.169.1.2',
    '192.168.001.1', '10.0.0.256', '10.0.0.1:443', '10.0.0.1.evil.example', '[::1]', 'user@10.0.0.1']) {
    await t.test(`rejected ${ip}`, async () => {
      const storage = new MemoryStore();
      await assert.rejects(pairDevice({ ...DEVICE, ip }, { storage, crypto: webcrypto }), { code: 'address' });
      assert.equal(storage.writes.length, 0);
    });
  }
  const storage = new MemoryStore();
  const zero = await pairDevice({ ...DEVICE, ip: '0.0.0.0' }, { storage, crypto: webcrypto });
  assert.equal(zero.ip, null);
});

test('pair metadata is bound to its exact device hostname, port, and canonical secret', async (t) => {
  for (const change of [
    { host: 'cardputer-ffffff.local' }, { host: 'cardputer-aabbcc.local.evil.example' },
    { host: 'http://cardputer-aabbcc.local' }, { port: 80 }, { port: '8080' },
    { deviceId: '001122aabbcc' }, { controlSecret: 'x'.repeat(43) },
    { controlSecret: Buffer.alloc(31).toString('base64url') }, { type: 'saved' },
  ]) await t.test(Object.keys(change)[0], async () => {
    const storage = new MemoryStore();
    await assert.rejects(pairDevice({ ...DEVICE, ...change }, { storage, crypto: webcrypto }));
    assert.equal(storage.writes.length, 0);
  });
});

test('tampered saved metadata and extractable keys are rejected before any LAN request', async (t) => {
  for (const change of [
    { host: 'attacker.example' }, { ip: '8.8.8.8' }, { deviceId: '000000000000' },
    { requestKey: await webcrypto.subtle.importKey('raw', derive('request'), { name: 'AES-GCM' }, true, ['encrypt']) },
  ]) await t.test(Object.keys(change)[0], async () => {
    const h = await fixture();
    h.storage.records.set(DEVICE.deviceId, { ...h.storage.records.get(DEVICE.deviceId), ...change });
    await assert.rejects(h.controller.send({ apiKey: API_KEY }));
    assert.equal(h.lan.calls.length, 0);
  });
});

test('forget removes only the selected browser pairing and invalid entries are never listed', async () => {
  const storage = new MemoryStore();
  await pairDevice({ ...DEVICE }, { storage, crypto: webcrypto });
  await pairDevice({ ...DEVICE, deviceId: '001122112233', host: 'cardputer-112233.local' }, { storage, crypto: webcrypto });
  storage.records.set('invalid', { deviceId: 'invalid', apiKey: API_KEY, controlSecret: CONTROL_SECRET });
  await forgetDevice(DEVICE.deviceId, { storage });
  const list = await listPairedDevices({ storage });
  assert.equal(list.length, 1);
  assert.equal(list[0].deviceId, '001122112233');
  assert.doesNotMatch(JSON.stringify(list), new RegExp(`${API_KEY}|${CONTROL_SECRET}`));
});

test('pending approval polls stop on physical cancellation or the sixty-second deadline', async (t) => {
  await t.test('physical cancellation', async () => {
    const h = await fixture({ plainMutator: (value, command) => command.type === 'status' ? { ...value, type: 'cancelled' } : value });
    const sending = h.controller.send({ apiKey: API_KEY });
    const rejected = assert.rejects(sending, { code: 'device_cancelled' });
    await until(() => h.statuses.some((status) => status.code === 'confirm'));
    h.clock.advance(1200);
    await rejected;
    assert.equal(h.saved.length, 0);
    assert.equal(h.clock.timers.size, 0);
  });
  await t.test('confirmation timeout', async () => {
    const h = await fixture({ alwaysPending: true });
    const sending = h.controller.send({ apiKey: API_KEY });
    const rejected = assert.rejects(sending, { code: 'confirmation_timeout' });
    await until(() => h.statuses.some((status) => status.code === 'confirm'));
    h.clock.advance(60000);
    await rejected;
    assert.equal(h.saved.length, 0);
    assert.equal(h.clock.timers.size, 0);
  });
});

test('cancel aborts pending network work and raw browser errors cannot expose keys', async () => {
  let request;
  const h = await fixture({ fetchError: (_url, options) => {
    request = options;
    return new Promise(() => {});
  } });
  const opening = h.controller.openSetup();
  const rejected = assert.rejects(opening, { code: 'cancelled' });
  await until(() => request);
  h.controller.cancel();
  await rejected;
  assert.equal(request.signal.aborted, true);
  assert.equal(h.clock.timers.size, 0);
  const failure = await fixture({ fetchError: () => { throw new Error(API_KEY); } });
  await assert.rejects(failure.controller.openSetup(), { code: 'network' });
  assert.doesNotMatch(JSON.stringify(failure.statuses), new RegExp(API_KEY));
});

test('unknown encrypted error text and unexpected plaintext fields are never echoed or returned', async () => {
  const h = await fixture({ immediateSaved: true, plainMutator: (value) => ({ ...value, apiKey: API_KEY, controlSecret: CONTROL_SECRET }) });
  const result = await h.controller.send({ apiKey: API_KEY });
  assert.equal(Object.hasOwn(result, 'apiKey'), false);
  assert.equal(Object.hasOwn(result, 'controlSecret'), false);
  const failed = await fixture({ plainMutator: (value) => ({ ...value, type: 'error', code: `${API_KEY} <img onerror=alert(1)>` }) });
  await assert.rejects(failed.controller.send({ apiKey: API_KEY }), { code: 'protocol' });
  assert.doesNotMatch(JSON.stringify(failed.statuses), /fixture_provider|<img|onerror/);
});

test('provider keys are never written during later wireless sends or status checks', async () => {
  const h = await fixture({ immediateSaved: true });
  const first = await h.controller.send({ provider: 'elevenlabs', apiKey: API_KEY, referenceId: 'agent_test' });
  await h.controller.status(first.operationId);
  assert.equal(h.storage.writes.length, 1);
  assert.doesNotMatch(JSON.stringify(h.storage.writes), new RegExp(API_KEY));
  assert.equal(new Set(h.lan.envelopes.map((value) => value.iv)).size, 2);
});

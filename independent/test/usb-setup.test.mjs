import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsbSetup, bindUsbSetup, getUsbSetupController } from '../public/usb-setup.js';

const PREFIX = 'CVSETUP/1 ';
const SECRET = 'fixture_API_key_1234567890';
const ENCODER = new TextEncoder();
const settle = () => new Promise((resolve) => setImmediate(resolve));

class FakeClock {
  time = 0;
  next = 1;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + delay, callback });
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let count = 0; count < 20; count += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('Expected mocked serial state was not reached');
}

class FakePort {
  opened = false;
  openCalls = [];
  signals = [];
  frames = [];
  writes = [];
  cancels = 0;
  aborts = 0;
  closes = 0;
  input;
  closedStream = false;

  constructor({ autoHello = true, autoPending = true, setupReply = 'setup_open',
    fragment = false, writeHook, openHook, cancelError = false, abortError = false } = {}) {
    this.options = { autoHello, autoPending, setupReply, fragment, writeHook, openHook, cancelError, abortError };
    this.readable = new ReadableStream({
      start: (controller) => { this.input = controller; },
      cancel: () => {
        this.cancels += 1;
        this.closedStream = true;
        if (cancelError) return Promise.reject(new Error(SECRET));
      },
    });
    this.writable = new WritableStream({
      write: async (chunk) => {
        const captured = new Uint8Array(chunk);
        const text = new TextDecoder().decode(captured);
        this.writes.push(text);
        for (const line of text.split('\n')) {
          if (!line.startsWith(PREFIX)) continue;
          const frame = JSON.parse(line.slice(PREFIX.length));
          this.frames.push(frame);
          if (writeHook) await writeHook(this, frame);
          else if (frame.type === 'hello' && autoHello) this.line({ type: 'ready', id: frame.id, protocol: 1 });
          else if (frame.type === 'configure' && autoPending) this.line({ type: 'pending', id: frame.id });
          else if (frame.type === 'pair_wireless' && autoPending) this.line({ type: 'pending', id: frame.id });
          else if (frame.type === 'open_setup') this.line({ type: setupReply, id: frame.id });
        }
      },
      abort: () => { this.aborts += 1; if (abortError) return Promise.reject(new Error(SECRET)); },
    });
  }

  async open(options) {
    this.openCalls.push(options);
    if (this.options.openHook) await this.options.openHook();
    this.opened = true;
  }

  async setSignals(signals) { this.signals.push(signals); }
  async close() {
    this.closes += 1;
    assert.equal(this.readable.locked, false, 'release the reader lock before closing the port');
    assert.equal(this.writable.locked, false, 'release the writer lock before closing the port');
    this.opened = false;
  }

  raw(text, fragment = this.options.fragment) {
    if (this.closedStream) return;
    const data = ENCODER.encode(text);
    if (fragment) {
      for (let offset = 0; offset < data.length; offset += 3) this.input.enqueue(data.slice(offset, offset + 3));
    } else this.input.enqueue(data);
  }
  line(message, fragment = this.options.fragment) { this.raw(`${PREFIX}${JSON.stringify(message)}\r\n`, fragment); }
  get configure() { return this.frames.findLast((frame) => frame.type === 'configure'); }
  approve() { this.line({ type: 'saved', id: this.configure.id, provider: this.configure.provider }); }
  approvePair(change = {}) {
    const pair = this.frames.findLast((frame) => frame.type === 'pair_wireless');
    this.line({ type: 'paired', id: pair.id, deviceId: '001122AABBCC', host: 'cardputer-aabbcc.local',
      port: 8080, ip: '192.168.1.51', controlSecret: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url'), ...change });
  }
}

function setup(portOptions = {}, overrides = {}) {
  const clock = new FakeClock();
  const port = new FakePort(portOptions);
  const statuses = [];
  const saved = [];
  const busy = [];
  const requests = [];
  let nextId = 1;
  const options = {
    navigatorSerial: { requestPort(options) { requests.push(options); return Promise.resolve(port); } },
    clock, createId: () => `request-${nextId++}`,
    onStatus: (status) => statuses.push(status), onSaved: (value) => saved.push(value),
    onBusy: (value) => busy.push(value), ...overrides,
  };
  const controller = createUsbSetup(options);
  return {
    clock, port, statuses, saved, busy, requests, options, controller,
    send: (value = {}) => controller.send({ provider: 'gemini', apiKey: SECRET, ...value }),
  };
}

function assertClosed(h) {
  assert.equal(h.controller.busy, false);
  assert.equal(h.port.readable.locked, false);
  assert.equal(h.port.writable.locked, false);
  assert.equal(h.port.closes, 1);
  assert.equal(h.clock.timers.size, 0);
}

test('USB provisioning waits for a fresh fragmented handshake and physical confirmation', async () => {
  const h = setup({ fragment: true });
  const sending = h.send();
  await until(() => h.statuses.some((status) => status.code === 'confirm'));
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0], { filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] });
  assert.equal(h.port.openCalls[0].baudRate, 115200);
  assert.deepEqual(h.port.signals, [{ dataTerminalReady: true, requestToSend: false }]);
  assert.equal(h.controller.busy, true);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(h.port.frames.map((frame) => frame.type), ['hello', 'configure']);
  assert.deepEqual(h.port.configure, {
    type: 'configure', id: 'request-2', provider: 'gemini', apiKey: SECRET, referenceId: '', voice: 'Aoede',
  });
  assert.ok(h.port.writes.every((line) => line.startsWith('\nCVSETUP/1 ')), 'leading newline resynchronizes an old partial command');
  h.port.approve();
  assert.deepEqual(await sending, { provider: 'gemini' });
  assert.deepEqual(h.saved, [{ provider: 'gemini' }]);
  assert.deepEqual(h.busy, [true, false]);
  assert.equal(h.statuses.at(-1).code, 'saved');
  assert.doesNotMatch(JSON.stringify([h.statuses, h.saved]), new RegExp(SECRET));
  assertClosed(h);
});

test('provider references are sent only to USB, while Gemini drops an unrelated reference', async (t) => {
  for (const [provider, referenceId] of [['gemini', 'ignored'], ['elevenlabs', 'agent_example'], ['hume', '12345678-1234-4234-8234-123456789abc']]) {
    await t.test(provider, async () => {
      const h = setup();
      const sending = h.send({ provider, referenceId });
      await until(() => h.port.configure);
      h.port.approve();
      await sending;
      assert.equal(h.port.configure.referenceId, provider === 'gemini' ? '' : referenceId);
      assert.equal(h.port.configure.provider, provider);
      assertClosed(h);
    });
  }
});

test('a stale handshake ID never authorizes the API key, and retries stay bounded', async () => {
  const h = setup({ autoHello: false });
  const sending = h.send();
  await until(() => h.port.frames.length === 1);
  const firstId = h.port.frames[0].id;
  h.port.line({ type: 'ready', id: 'stale-device-reply', protocol: 1 });
  h.clock.advance(2000);
  await until(() => h.port.frames.length === 2);
  const latestId = h.port.frames[1].id;
  assert.notEqual(firstId, latestId);
  h.port.line({ type: 'ready', id: firstId, protocol: 1 });
  await settle();
  assert.equal(h.port.configure, undefined);
  h.port.line({ type: 'ready', id: latestId, protocol: 1 });
  await until(() => h.port.configure);
  h.port.approve();
  await sending;
  assert.equal(h.port.frames.filter((frame) => frame.type === 'hello').length, 2);
  assertClosed(h);
});

test('old or silent firmware receives no key and produces an update/reset hint within six seconds', async () => {
  const h = setup({ autoHello: false });
  const sending = h.send();
  const rejected = assert.rejects(sending, (error) => error.code === 'firmware' && /Update.*firmware.*Reset/.test(error.message));
  await until(() => h.port.frames.length === 1);
  for (let attempt = 0; attempt < 3; attempt += 1) { h.clock.advance(2000); await settle(); }
  await rejected;
  assert.equal(h.port.frames.length, 3);
  assert.ok(h.port.frames.every((frame) => frame.type === 'hello' && !Object.hasOwn(frame, 'apiKey')));
  assertClosed(h);
});

test('boot log noise and oversized non-protocol lines resynchronize safely', async () => {
  const h = setup({ autoHello: false });
  const sending = h.send();
  await until(() => h.port.frames.length === 1);
  h.port.raw(`ROM boot log with ${SECRET}\n${'x'.repeat(6000)}\n`);
  h.port.line({ type: 'ready', id: h.port.frames[0].id, protocol: 1 }, true);
  await until(() => h.port.configure);
  h.port.approve();
  await sending;
  assert.doesNotMatch(JSON.stringify(h.statuses), new RegExp(SECRET));
  assertClosed(h);
});

test('an oversized partial protocol line fails with a bounded safe error and no API-key write', async () => {
  const h = setup({ autoHello: false });
  const sending = h.send();
  const rejected = assert.rejects(sending, { code: 'protocol' });
  await until(() => h.port.frames.length === 1);
  h.port.raw(`${PREFIX}{"type":"ready","id":"${'z'.repeat(5000)}`);
  await rejected;
  assert.equal(h.port.configure, undefined);
  assert.doesNotMatch(JSON.stringify(h.statuses), /zzzzzz/);
  assertClosed(h);
});

test('saved must follow matching pending, ID, and provider acknowledgements', async (t) => {
  await t.test('saved without physical-confirmation pending is rejected', async () => {
    const h = setup({ autoPending: false });
    const sending = h.send();
    const rejected = assert.rejects(sending, { code: 'protocol' });
    await until(() => h.port.configure);
    h.port.approve();
    await rejected;
    assert.equal(h.saved.length, 0);
    assertClosed(h);
  });
  await t.test('a stale saved ID is ignored, not used to clear the key', async () => {
    const h = setup();
    const sending = h.send();
    await until(() => h.statuses.some((status) => status.code === 'confirm'));
    h.port.line({ type: 'saved', id: 'another-request', provider: 'gemini' });
    await settle();
    assert.equal(h.saved.length, 0);
    assert.equal(h.controller.busy, true);
    h.port.approve();
    await sending;
    assertClosed(h);
  });
  await t.test('a provider mismatch cannot claim success', async () => {
    const h = setup();
    const sending = h.send();
    const rejected = assert.rejects(sending, { code: 'protocol' });
    await until(() => h.statuses.some((status) => status.code === 'confirm'));
    h.port.line({ type: 'saved', id: h.port.configure.id, provider: 'hume' });
    await rejected;
    assert.equal(h.saved.length, 0);
    assertClosed(h);
  });
});

test('not_in_setup explains the on-device shortcut and releases the serial port', async () => {
  const h = setup({ autoPending: false });
  const sending = h.send();
  const rejected = assert.rejects(sending, (error) => error.code === 'not_in_setup' && /Fn \+ W.*two seconds/.test(error.message));
  await until(() => h.port.configure);
  h.port.line({ type: 'error', id: h.port.configure.id, code: 'not_in_setup' });
  await rejected;
  assertClosed(h);
});

test('physical cancellation preserves the key input for retry without claiming success', async () => {
  const h = setup();
  const sending = h.send();
  const rejected = assert.rejects(sending, { code: 'device_cancelled' });
  await until(() => h.port.configure);
  h.port.line({ type: 'cancelled', id: h.port.configure.id });
  await rejected;
  assert.equal(h.saved.length, 0);
  assertClosed(h);
});

test('duplicate pending messages cannot extend the sixty-second confirmation window', async () => {
  const h = setup();
  const sending = h.send();
  const rejected = assert.rejects(sending, { code: 'confirmation_timeout' });
  await until(() => h.statuses.some((status) => status.code === 'confirm'));
  h.clock.advance(20000);
  h.port.line({ type: 'pending', id: h.port.configure.id });
  await settle();
  h.clock.advance(40000);
  await rejected;
  assert.equal(h.saved.length, 0);
  assertClosed(h);
});

test('requestPort is never invoked automatically or for invalid/unsupported input', async (t) => {
  const h = setup();
  assert.equal(h.requests.length, 0);
  for (const input of [
    { provider: 'unsupported' }, { apiKey: '' }, { apiKey: 'wrong key contains spaces' },
    { provider: 'elevenlabs', referenceId: '' }, { provider: 'hume', referenceId: 'https://wrong.example' },
  ]) {
    await t.test(JSON.stringify(Object.keys(input)), async () => {
      await assert.rejects(h.send(input));
      assert.equal(h.requests.length, 0);
    });
  }
  const unavailable = createUsbSetup({ navigatorSerial: null });
  await assert.rejects(unavailable.send({ provider: 'gemini', apiKey: SECRET }), { code: 'unsupported' });
});

test('chooser cancellation and native open errors never expose browser error messages', async (t) => {
  await t.test('chooser cancelled', async () => {
    const h = setup({}, { navigatorSerial: { requestPort() { return Promise.reject(new DOMException(SECRET, 'NotFoundError')); } } });
    await assert.rejects(h.send(), { code: 'chooser_cancelled' });
    assert.doesNotMatch(JSON.stringify(h.statuses), new RegExp(SECRET));
    assert.equal(h.port.openCalls.length, 0);
    assert.equal(h.controller.busy, false);
  });
  await t.test('port belongs to the installer or another app', async () => {
    const h = setup({ openHook: () => { throw new DOMException(SECRET, 'InvalidStateError'); } });
    await assert.rejects(h.send(), (error) => error.code === 'port_busy' && /Close the installer/.test(error.message));
    assert.equal(h.port.closes, 0, 'do not close a port this operation never opened');
    assert.doesNotMatch(JSON.stringify(h.statuses), new RegExp(SECRET));
  });
});

test('a native port open that finishes after timeout is closed without sending a key', async () => {
  const opening = deferred();
  const h = setup({ openHook: () => opening.promise });
  const sending = h.send();
  const rejected = assert.rejects(sending, { code: 'port_busy' });
  await until(() => h.port.openCalls.length === 1);
  h.clock.advance(6000);
  await rejected;
  assert.equal(h.port.closes, 0);
  opening.resolve();
  await until(() => h.port.closes === 1);
  assert.equal(h.port.frames.length, 0);
  assert.equal(h.port.opened, false);
  assert.equal(h.clock.timers.size, 0);
});

test('browser cancellation releases a pending confirmation and makes no extra writes', async () => {
  const h = setup();
  const sending = h.send();
  const rejected = assert.rejects(sending, { code: 'cancelled' });
  await until(() => h.statuses.some((status) => status.code === 'confirm'));
  const writes = h.port.frames.length;
  assert.equal(h.controller.cancel(), true);
  await rejected;
  assert.equal(h.port.frames.length, writes);
  assert.equal(h.controller.cancel(), false);
  assertClosed(h);
});

test('a stalled writer cannot keep the UI or port locked after handshake timeout', async () => {
  const writing = deferred();
  const h = setup({ writeHook: () => writing.promise });
  const sending = h.send();
  const rejected = assert.rejects(sending, { code: 'firmware' });
  await until(() => h.port.frames.length === 1);
  h.clock.advance(6000);
  await settle();
  h.clock.advance(1000);
  await rejected;
  assertClosed(h);
  writing.resolve();
  await settle();
  assert.equal(h.saved.length, 0);
});

test('a read disconnect and cleanup errors still release both stream locks and attempt port close', async (t) => {
  await t.test('read disconnect', async () => {
    const h = setup();
    const sending = h.send();
    const rejected = assert.rejects(sending, { code: 'disconnected' });
    await until(() => h.port.configure);
    h.port.input.error(new Error(SECRET));
    await rejected;
    assert.doesNotMatch(JSON.stringify(h.statuses), new RegExp(SECRET));
    assertClosed(h);
  });
  await t.test('cleanup exceptions do not obscure a saved acknowledgement', async () => {
    const h = setup({ cancelError: true, abortError: true });
    const sending = h.send();
    await until(() => h.port.configure);
    h.port.approve();
    await sending;
    assert.equal(h.saved.length, 1);
    assertClosed(h);
  });
});

test('device errors are mapped to fixed safe text rather than echoed to the page', async () => {
  const h = setup({ autoPending: false });
  const sending = h.send();
  const rejected = assert.rejects(sending, { code: 'protocol' });
  await until(() => h.port.configure);
  h.port.line({ type: 'error', id: h.port.configure.id, code: `${SECRET} <img onerror=alert(1)>` });
  await rejected;
  assert.doesNotMatch(JSON.stringify(h.statuses), /fixture_API|<img|onerror/);
  assertClosed(h);
});

test('openSetup sends no credential and handles both firmware setup states', async (t) => {
  for (const state of ['setup_open', 'restarting']) {
    await t.test(state, async () => {
      const h = setup({ setupReply: state });
      assert.equal(h.requests.length, 0);
      const result = await h.controller.openSetup();
      assert.deepEqual(result, { state });
      assert.deepEqual(h.port.frames, [{ type: 'hello', id: 'request-1' }, { type: 'open_setup', id: 'request-2' }]);
      assert.equal(h.saved.length, 0, 'opening setup never claims that an API key was saved');
      assert.equal(h.statuses.at(-1).code, state);
      assert.match(h.statuses.at(-1).message, state === 'restarting' ? /restarting into setup/ : /setup is open/);
      assertClosed(h);
    });
  }
});

class FakeElement extends EventTarget {
  value = '';
  disabled = true;
  hidden = false;
  required = false;
  textContent = '';
  href = '';
  dataset = {};
  attributes = {};
  setAttribute(name, value) { this.attributes[name] = value; }
  reportValidity() { return true; }
}

function dom() {
  const ids = ['usb-setup-form', 'usb-provider', 'usb-api-key', 'usb-reference', 'usb-reference-field',
    'usb-send', 'usb-status', 'usb-reference-label', 'usb-api-key-label', 'usb-provider-key-link', 'usb-open-setup'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements['usb-provider'].value = 'gemini';
  const window = new EventTarget();
  return { elements, window, document: { getElementById: (id) => elements[id] || null, defaultView: window } };
}

test('form binding defaults to Gemini, authorizes only on a click, and clears the key only after saved', async () => {
  const h = setup();
  const d = dom();
  const setupUi = bindUsbSetup(d.document, h.options);
  const get = (id) => d.elements[id];
  assert.equal(h.requests.length, 0);
  assert.equal(get('usb-send').disabled, false);
  assert.equal(get('usb-open-setup').disabled, false);
  assert.equal(get('usb-reference-field').hidden, true);
  assert.equal(get('usb-api-key-label').textContent, 'Google AI Studio API key');
  assert.equal(get('usb-provider-key-link').href, 'https://aistudio.google.com/apikey');
  get('usb-api-key').value = SECRET;
  const event = new Event('submit', { cancelable: true });
  get('usb-setup-form').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.requests.length, 1, 'requestPort is reached synchronously within the user submit gesture');
  assert.equal(get('usb-send').disabled, true);
  await until(() => h.port.configure);
  assert.equal(get('usb-api-key').value, SECRET);
  h.port.approve();
  await until(() => !setupUi.busy);
  assert.equal(get('usb-api-key').value, '');
  assert.equal(get('usb-send').disabled, false);
  assert.equal(get('usb-status').attributes['aria-live'], 'polite');
  assert.doesNotMatch(get('usb-status').textContent, new RegExp(SECRET));
});

test('changing providers changes key labels/links and removes a previously pasted key', () => {
  const h = setup();
  const d = dom();
  bindUsbSetup(d.document, h.options);
  const get = (id) => d.elements[id];
  for (const provider of ['elevenlabs', 'hume', 'gemini']) {
    get('usb-api-key').value = SECRET;
    get('usb-reference').value = 'old-reference';
    get('usb-provider').value = provider;
    get('usb-provider').dispatchEvent(new Event('change'));
    assert.equal(get('usb-api-key').value, '');
    assert.equal(get('usb-reference').value, '');
    assert.equal(get('usb-reference-field').hidden, provider === 'gemini');
    assert.equal(get('usb-reference').required, provider !== 'gemini');
    assert.match(get('usb-api-key-label').textContent, provider === 'gemini' ? /Google/ : provider === 'hume' ? /Hume/ : /ElevenLabs/);
    assert.equal(h.requests.length, 0);
  }
});

test('the Open setup button sends no pasted key and pagehide cancels a pending Send', async () => {
  const h = setup();
  const d = dom();
  const ui = bindUsbSetup(d.document, h.options);
  d.elements['usb-api-key'].value = SECRET;
  d.elements['usb-open-setup'].dispatchEvent(new Event('click', { cancelable: true }));
  await until(() => !ui.busy);
  assert.ok(h.port.frames.every((frame) => !Object.hasOwn(frame, 'apiKey')));
  assert.equal(d.elements['usb-api-key'].value, SECRET, 'opening setup does not falsely claim to save a key');

  const next = setup();
  const secondDom = dom();
  const secondUi = bindUsbSetup(secondDom.document, next.options);
  secondDom.elements['usb-api-key'].value = SECRET;
  secondDom.elements['usb-setup-form'].dispatchEvent(new Event('submit', { cancelable: true }));
  await until(() => next.port.configure);
  secondDom.window.dispatchEvent(new Event('pagehide'));
  await until(() => !secondUi.busy);
  assert.equal(secondDom.elements['usb-api-key'].value, '');
  assert.equal(next.port.closes, 1);
  assert.equal(next.saved.length, 0);
});

test('unsupported browsers leave both USB controls disabled and do not authorize ports', () => {
  const d = dom();
  const ui = bindUsbSetup(d.document, { navigatorSerial: null });
  assert.equal(ui.supported, false);
  assert.equal(d.elements['usb-send'].disabled, true);
  assert.equal(d.elements['usb-open-setup'].disabled, true);
  assert.match(d.elements['usb-status'].textContent, /desktop Chrome or Edge/);
});

test('USB setup never invokes HTTP or browser storage with credentials', async () => {
  const fetchBefore = globalThis.fetch;
  const localBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sessionBefore = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  globalThis.fetch = () => { assert.fail('USB setup must not upload a key over HTTP'); };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { assert.fail('No credential storage'); } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { assert.fail('No credential storage'); } });
  try {
    const h = setup();
    const sending = h.send();
    await until(() => h.port.configure);
    h.port.approve();
    await sending;
    assertClosed(h);
  } finally {
    globalThis.fetch = fetchBefore;
    if (localBefore) Object.defineProperty(globalThis, 'localStorage', localBefore); else delete globalThis.localStorage;
    if (sessionBefore) Object.defineProperty(globalThis, 'sessionStorage', sessionBefore); else delete globalThis.sessionStorage;
  }
});

test('wireless pairing is a credential-free USB command with separate physical approval', async () => {
  const pairs = [];
  const h = setup({}, { onPaired: (value) => pairs.push(value) });
  const pairing = h.controller.pairWireless();
  await until(() => h.port.frames.some((frame) => frame.type === 'pair_wireless'));
  assert.deepEqual(h.port.frames, [{ type: 'hello', id: 'request-1' }, { type: 'pair_wireless', id: 'request-2' }]);
  assert.equal(pairs.length, 0);
  assert.equal(h.saved.length, 0);
  h.port.approvePair();
  const result = await pairing;
  assert.equal(result.type, 'paired');
  assert.equal(result.deviceId, '001122AABBCC');
  assert.equal(result.controlSecret.length, 43);
  assert.equal(pairs.length, 1);
  assert.equal(h.saved.length, 0, 'pairing must not falsely clear an API key via onSaved');
  assert.doesNotMatch(JSON.stringify(h.statuses), new RegExp(result.controlSecret));
  assertClosed(h);
});

test('paired metadata is validated before returning a control secret or calling a hook', async (t) => {
  for (const change of [
    { deviceId: '001122aabbcc' }, { host: 'attacker.example' }, { host: 'cardputer-ffffff.local' },
    { port: 80 }, { controlSecret: 'not-a-secret' }, { controlSecret: 'x'.repeat(43) },
  ]) await t.test(Object.keys(change)[0], async () => {
    const pairs = [];
    const h = setup({}, { onPaired: (value) => pairs.push(value) });
    const pairing = h.controller.pairWireless();
    const rejected = assert.rejects(pairing, { code: 'protocol' });
    await until(() => h.port.frames.some((frame) => frame.type === 'pair_wireless'));
    h.port.approvePair(change);
    await rejected;
    assert.equal(pairs.length, 0);
    assertClosed(h);
  });
});

test('the bound USB controller can be reused by the wireless UI without duplicate bindings', () => {
  const h = setup();
  const d = dom();
  assert.equal(getUsbSetupController(d.document), null);
  const first = bindUsbSetup(d.document, h.options);
  assert.equal(getUsbSetupController(d.document), first);
  assert.equal(bindUsbSetup(d.document, h.options), first);
  assert.equal(typeof first.pairWireless, 'function');
  assert.equal(h.requests.length, 0);
});

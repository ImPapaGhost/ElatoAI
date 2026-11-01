import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWirelessSetupUi } from '../public/wireless-setup-ui.js';

const API_KEY = 'fixture_provider_key_0123456789';
const CONTROL_SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url');
const DEVICE = { deviceId: '001122AABBCC', host: 'cardputer-aabbcc.local', ip: '192.168.1.51', port: 8080 };
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 50; i += 1) { if (predicate()) return; await settle(); } assert.fail('Expected UI state not reached'); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class UiEvent {
  constructor(type) { this.type = type; }
  defaultPrevented = false;
  stopped = false;
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

class Element {
  listeners = new Map();
  value = '';
  checked = false;
  disabled = false;
  textContent = '';
  children = [];
  dataset = {};
  attributes = {};
  valid = true;
  addEventListener(type, callback, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ callback, capture: options === true || options?.capture === true });
  }
  dispatchEvent(original) {
    const event = original instanceof UiEvent ? original : new UiEvent(original.type);
    const listeners = [...(this.listeners.get(event.type) || [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const listener of listeners) { listener.callback(event); if (event.stopped) break; }
    return !event.defaultPrevented;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  reportValidity() { return this.valid; }
  replaceChildren() { this.children = []; this.value = ''; }
  append(child) { this.children.push(child); }
}

function fixture(overrides = {}) {
  const ids = ['wireless-settings', 'wifi-pair', 'wifi-device', 'wifi-enabled', 'wifi-forget', 'wifi-status',
    'usb-setup-form', 'usb-provider', 'usb-api-key', 'usb-reference', 'usb-open-setup', 'usb-send', 'usb-status',
    'setup-connection-help', 'setup-transport-privacy'];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  elements['usb-provider'].value = 'gemini';
  elements['usb-api-key'].value = API_KEY;
  elements['usb-send'].textContent = 'Send to Cardputer';
  elements['usb-open-setup'].textContent = 'Open Cardputer setup';
  elements['setup-connection-help'].textContent = 'Original USB help';
  elements['setup-transport-privacy'].textContent = 'Original USB privacy';
  const window = new Element();
  const document = { getElementById: (id) => elements[id] || null, createElement: () => new Element(), defaultView: window };
  const calls = { usbSend: 0, usbOpen: 0, usbPair: 0, lanFactory: 0, lanSend: [], lanOpen: 0, cancel: 0, pairStored: [], forgotten: [] };
  let records = overrides.records || [{ ...DEVICE }];
  const usb = { supported: true, busy: false, pairWireless() {
    calls.usbPair += 1;
    return Promise.resolve({ type: 'paired', ...DEVICE, id: 'usb-pair', controlSecret: CONTROL_SECRET });
  }, ...overrides.usb };
  // Existing USB handlers intentionally register first. The wireless handler
  // must still intercept them by capturing the DOM event at the target.
  elements['usb-setup-form'].addEventListener('submit', () => { calls.usbSend += 1; });
  elements['usb-open-setup'].addEventListener('click', () => { calls.usbOpen += 1; });
  const options = {
    getUsbController: () => usb,
    listDevicesImpl: async () => records.map((record) => ({ ...record })),
    pairDeviceImpl: async (metadata) => {
      calls.pairStored.push(metadata);
      records = [{ ...DEVICE }];
      return { ...DEVICE };
    },
    forgetDeviceImpl: async (id) => { calls.forgotten.push(id); records = records.filter((record) => record.deviceId !== id); },
    wirelessFactory: (options) => {
      calls.lanFactory += 1;
      return {
        async send(config) { calls.lanSend.push(config); options.onStatus({ code: 'saved', message: 'Saved wirelessly.', kind: 'success' }); return { type: 'saved' }; },
        async openSetup() { calls.lanOpen += 1; options.onStatus({ code: 'setup_open', message: 'Setup is open.', kind: 'success' }); return { state: 'setup_open' }; },
        cancel() { calls.cancel += 1; },
      };
    },
    ...overrides.options,
  };
  const ui = bindWirelessSetupUi(document, options);
  const get = (id) => elements[id];
  const enable = () => { get('wifi-enabled').checked = true; get('wifi-enabled').dispatchEvent(new UiEvent('change')); };
  return { ui, usb, calls, elements, get, enable, window, document, options };
}

test('wireless UI reads pairing metadata on load but keeps USB as the default without LAN access', async () => {
  const h = fixture();
  await h.ui.ready;
  assert.equal(h.get('wifi-enabled').checked, false);
  assert.equal(h.calls.lanFactory, 0);
  assert.equal(h.get('wifi-device').children.length, 1);
  assert.equal(h.get('usb-send').textContent, 'Send to Cardputer');
  assert.equal(h.get('setup-connection-help').textContent, 'Original USB help');
  h.get('usb-setup-form').dispatchEvent(new UiEvent('submit'));
  h.get('usb-open-setup').dispatchEvent(new UiEvent('click'));
  assert.equal(h.calls.usbSend, 1);
  assert.equal(h.calls.usbOpen, 1);
  assert.equal(h.calls.lanFactory, 0);
});

test('checking Wi-Fi changes labels and privacy copy without contacting a device', async () => {
  const h = fixture();
  await h.ui.ready;
  h.enable();
  assert.equal(h.calls.lanFactory, 0);
  assert.equal(h.get('usb-send').textContent, 'Send over Wi-Fi');
  assert.equal(h.get('usb-open-setup').textContent, 'Open setup over Wi-Fi');
  assert.match(h.get('setup-transport-privacy').textContent, /encrypted/);
  assert.match(h.get('setup-connection-help').textContent, /same Wi-Fi/);
});

test('wireless capture intercepts USB submit and clears the key only after saved', async () => {
  const pending = deferred();
  let opts;
  const h = fixture({ options: { wirelessFactory(options) {
    opts = options;
    return { send: () => pending.promise };
  } } });
  await h.ui.ready;
  h.enable();
  const event = new UiEvent('submit');
  h.get('usb-setup-form').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.calls.usbSend, 0);
  assert.equal(h.ui.busy, true);
  assert.equal(h.get('usb-api-key').disabled, true);
  assert.equal(h.get('usb-api-key').value, API_KEY);
  opts.onStatus({ message: 'Press Enter on the Cardputer.', kind: 'working' });
  pending.resolve({ type: 'saved' });
  await until(() => !h.ui.busy);
  assert.equal(h.get('usb-api-key').value, '');
  assert.equal(h.get('usb-api-key').disabled, false);
});

test('a pending or failed wireless result cannot clear a pasted key or echo an error payload', async (t) => {
  for (const result of ['pending', 'error']) await t.test(result, async () => {
    const h = fixture({ options: { wirelessFactory() {
      return { async send() {
        if (result === 'error') throw { name: 'WirelessSetupError', code: 'authentication', message: `${API_KEY} <img onerror=alert(1)>` };
        return { type: 'pending' };
      } };
    } } });
    await h.ui.ready;
    h.enable();
    h.get('usb-setup-form').dispatchEvent(new UiEvent('submit'));
    await until(() => !h.ui.busy);
    assert.equal(h.get('usb-api-key').value, API_KEY);
    assert.doesNotMatch(h.get('usb-status').textContent, /fixture_provider|<img|onerror/);
  });
});

test('wireless Open setup does not submit or read a provider key', async () => {
  const h = fixture();
  await h.ui.ready;
  h.enable();
  h.get('usb-open-setup').dispatchEvent(new UiEvent('click'));
  await until(() => !h.ui.busy);
  assert.equal(h.calls.lanOpen, 1);
  assert.equal(h.calls.usbOpen, 0);
  assert.equal(h.calls.lanSend.length, 0);
  assert.equal(h.get('usb-api-key').value, API_KEY);
});

test('USB pairing stays within the click gesture and awaits CryptoKey storage before enabling Wi-Fi', async () => {
  const persist = deferred();
  const metadata = { type: 'paired', ...DEVICE, id: 'usb-pair', controlSecret: CONTROL_SECRET };
  const h = fixture({ records: [], usb: { pairWireless() { h.calls.usbPair += 1; return Promise.resolve(metadata); } },
    options: { pairDeviceImpl: () => persist.promise } });
  await h.ui.ready;
  h.get('wifi-pair').dispatchEvent(new UiEvent('click'));
  assert.equal(h.calls.usbPair, 1, 'request pairing before any storage/network await');
  await settle();
  assert.equal(h.ui.busy, true);
  assert.equal(h.get('wifi-enabled').disabled, true);
  assert.equal(h.get('usb-api-key').value, API_KEY, 'pairing never pretends to save the provider key');
  persist.resolve({ ...DEVICE });
  await until(() => !h.ui.busy);
  assert.equal(Object.hasOwn(metadata, 'controlSecret'), false);
  assert.equal(h.get('wifi-enabled').checked, false);
  assert.equal(h.calls.lanFactory, 0);
});

test('forgetting pairing affects this browser only and never contacts the LAN', async () => {
  const h = fixture();
  await h.ui.ready;
  h.enable();
  h.get('wifi-forget').dispatchEvent(new UiEvent('click'));
  await until(() => !h.ui.busy);
  assert.deepEqual(h.calls.forgotten, [DEVICE.deviceId]);
  assert.equal(h.get('wifi-enabled').checked, false);
  assert.equal(h.get('wifi-device').children.length, 0);
  assert.equal(h.calls.lanFactory, 0);
});

test('USB busy events block both transports and prevent a synthetic wireless bypass', async () => {
  const h = fixture();
  await h.ui.ready;
  h.enable();
  h.usb.busy = true;
  h.get('usb-setup-form').dispatchEvent(new UiEvent('cv-usb-state'));
  assert.equal(h.get('wifi-enabled').disabled, true);
  assert.equal(h.get('usb-send').disabled, true);
  assert.equal(h.get('usb-open-setup').disabled, true);
  h.get('usb-setup-form').dispatchEvent(new UiEvent('submit'));
  h.get('usb-open-setup').dispatchEvent(new UiEvent('click'));
  assert.equal(h.calls.lanFactory, 0);
  assert.equal(h.calls.usbSend, 0);
  h.usb.busy = false;
  h.get('usb-setup-form').dispatchEvent(new UiEvent('cv-usb-state'));
  assert.equal(h.get('usb-send').disabled, false);
});

test('pagehide clears the key, disables wireless mode, and cancels pending polling', async () => {
  const pending = deferred();
  let cancelled = 0;
  const h = fixture({ options: { wirelessFactory() {
    return { send: () => pending.promise, cancel() { cancelled += 1; pending.reject({ code: 'cancelled' }); } };
  } } });
  await h.ui.ready;
  h.enable();
  h.get('usb-setup-form').dispatchEvent(new UiEvent('submit'));
  h.window.dispatchEvent(new UiEvent('pagehide'));
  await until(() => !h.ui.busy);
  assert.equal(cancelled, 1);
  assert.equal(h.get('usb-api-key').value, '');
  assert.equal(h.get('wifi-enabled').checked, false);
});

test('native form validation runs before a wireless request', async () => {
  const h = fixture();
  await h.ui.ready;
  h.enable();
  h.get('usb-setup-form').valid = false;
  h.get('usb-setup-form').dispatchEvent(new UiEvent('submit'));
  assert.equal(h.calls.lanFactory, 0);
  assert.equal(h.calls.usbSend, 0);
});

const PREFIX = 'CVSETUP/1 ';
const PREFIX_BYTES = new TextEncoder().encode(PREFIX);
const MAX_LINE_BYTES = 4096;
const FILTERS = [{ usbVendorId: 0x303a, usbProductId: 0x1001 }];
const PROVIDERS = Object.freeze({
  gemini: { label: 'Google AI Studio API key', link: 'https://aistudio.google.com/apikey', linkText: 'Get a Google AI Studio API key', reference: '' },
  elevenlabs: { label: 'ElevenLabs API key', link: 'https://elevenlabs.io/app/api/api-keys', linkText: 'Open ElevenLabs API keys', reference: 'ElevenLabs Agent ID' },
  hume: { label: 'Hume API key', link: 'https://app.hume.ai/developers', linkText: 'Open Hume API keys', reference: 'Hume Config ID' },
});
const ERRORS = Object.freeze({
  unsupported: 'Use desktop Chrome or Edge to send the key over USB.',
  secure_browser: 'Open this installer over HTTPS in desktop Chrome or Edge, then try again.',
  busy: 'USB setup is already running. Check the Cardputer for its confirmation prompt.',
  provider: 'Choose Gemini, ElevenLabs, or Hume.',
  api_key: 'Paste the API key from the provider selected above.',
  eleven_reference: 'Paste your ElevenLabs Agent ID.',
  hume_reference: 'Paste your Hume Config ID.',
  chooser_cancelled: 'No Cardputer was selected. Connect it with a USB data cable and try again.',
  permission: 'USB permission was not granted. Open this page in desktop Chrome or Edge and choose the Cardputer.',
  port_busy: 'Could not open the USB port. Close the installer, serial monitor, or other app using the Cardputer, then try again.',
  disconnected: 'The USB connection ended. Reconnect the Cardputer and try again.',
  firmware: 'Update to the latest Easy firmware, tap Reset on the Cardputer, then try sending the key again.',
  protocol: 'The Cardputer returned an unexpected setup reply. Update its Easy firmware, tap Reset, and try again.',
  not_in_setup: 'Click Open setup on this page, or hold Fn + W on the Cardputer for two seconds, then click Send again.',
  confirmation_timeout: 'Confirmation timed out. Click Send again, then press Enter on the Cardputer to approve.',
  device_cancelled: 'Setup was cancelled on the Cardputer. Its previous settings were kept.',
  cancelled: 'USB setup was cancelled.',
  save_failed: 'The Cardputer could not save the setup. Check its screen and try again.',
  device_busy: 'The Cardputer is already showing a setup confirmation. Finish or cancel that prompt, then try again.',
});
const defaultClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

class UsbSetupError extends Error {
  constructor(code) {
    super(ERRORS[code] || ERRORS.protocol);
    this.name = 'UsbSetupError';
    this.code = Object.hasOwn(ERRORS, code) ? code : 'protocol';
  }
}

function nonce() {
  if (!globalThis.crypto?.getRandomValues) throw new UsbSetupError('secure_browser');
  return [...globalThis.crypto.getRandomValues(new Uint8Array(12))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

function inputConfig(input) {
  const provider = input?.provider || 'gemini';
  if (!Object.hasOwn(PROVIDERS, provider)) throw new UsbSetupError('provider');
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!/^[A-Za-z0-9_.-]{16,256}$/.test(apiKey)) throw new UsbSetupError('api_key');
  const referenceId = provider === 'gemini' ? '' : typeof input?.referenceId === 'string' ? input.referenceId.trim() : '';
  if (provider !== 'gemini' && !/^[A-Za-z0-9_.-]{1,128}$/.test(referenceId)) {
    throw new UsbSetupError(provider === 'elevenlabs' ? 'eleven_reference' : 'hume_reference');
  }
  return { provider, apiKey, referenceId, voice: 'Aoede' };
}

function deviceError(code) {
  const codes = {
    not_in_setup: 'not_in_setup', busy: 'device_busy',
    invalid_provider: 'provider', invalid_key: 'api_key',
    invalid_api_key: 'api_key', invalid_reference: 'protocol',
    save_failed: 'save_failed', storage_failed: 'save_failed',
    confirmation_timeout: 'confirmation_timeout', approval_timeout: 'confirmation_timeout',
    expired: 'confirmation_timeout', cancelled: 'device_cancelled',
  };
  return new UsbSetupError(codes[code] || 'protocol');
}

/**
 * User-initiated USB provisioning only. No HTTP requests or browser storage are
 * used; the key is sent only after a fresh, nonce-matched firmware handshake.
 * The Cardputer must separately approve it with a physical Enter key press.
 */
export function createUsbSetup({
  navigatorSerial = globalThis.navigator?.serial,
  clock = defaultClock, createId = nonce,
  handshakeTimeoutMs = 6000, confirmationTimeoutMs = 60000,
  onStatus = () => {}, onSaved = () => {}, onBusy = () => {},
} = {}) {
  let current;
  const encoder = new TextEncoder();

  function notify(code, message, kind = 'working') {
    try { onStatus({ code, message, kind }); } catch {}
  }

  function busy(value) { try { onBusy(value); } catch {} }

  function id() {
    const value = createId();
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(value)) throw new UsbSetupError('secure_browser');
    return value;
  }

  function clearTimer(op, value) {
    if (value === undefined) return;
    clock.clearTimeout(value);
    op.timers.delete(value);
  }

  function timer(op, callback, delay) {
    const value = clock.setTimeout(() => { op.timers.delete(value); callback(); }, delay);
    op.timers.add(value);
    return value;
  }

  function stop(op, error) {
    if (op.interruption || op.closing) return;
    op.interruption = error;
    op.rejectStopped(error);
    op.wait?.finish(error);
  }

  function check(op) { if (op.interruption) throw op.interruption; }

  function reply(op, kind, requestId, provider, timeoutMs) {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const wait = {
      kind, id: requestId, provider, pending: false, timer: undefined, promise, done: false,
      arm(delay, code) {
        clearTimer(op, wait.timer);
        wait.timer = timer(op, () => wait.finish(new UsbSetupError(code)), delay);
      },
      finish(error, result) {
        if (wait.done) return;
        wait.done = true;
        clearTimer(op, wait.timer);
        if (op.wait === wait) op.wait = undefined;
        if (error) reject(error); else resolve(result);
      },
    };
    op.wait = wait;
    wait.arm(timeoutMs, kind === 'ready' ? 'firmware' : 'protocol');
    return wait;
  }

  function message(op, value) {
    const wait = op.wait;
    if (!wait || !value || typeof value !== 'object' || Array.isArray(value) || value.id !== wait.id) return;
    if (value.type === 'error') { wait.finish(deviceError(value.code)); return; }
    if (value.type === 'cancelled') { wait.finish(new UsbSetupError('device_cancelled')); return; }
    if (wait.kind === 'ready') {
      if (value.type !== 'ready' || value.protocol !== 1) wait.finish(new UsbSetupError('firmware'));
      else wait.finish(null, { ready: true });
      return;
    }
    if (wait.kind === 'open_setup') {
      if (value.type === 'setup_open' || value.type === 'restarting') {
        wait.finish(null, { state: value.type });
      } else wait.finish(new UsbSetupError('protocol'));
      return;
    }
    if (value.type === 'pending') {
      if (!wait.pending) {
        wait.pending = true;
        wait.arm(confirmationTimeoutMs, 'confirmation_timeout');
        notify('confirm', 'Press Enter on the Cardputer to approve saving this key. Press Esc there to cancel.');
      }
    } else if (value.type === 'saved' && wait.pending && value.provider === wait.provider) {
      wait.finish(null, { provider: wait.provider });
    } else wait.finish(new UsbSetupError('protocol'));
  }

  async function read(op) {
    const line = new Uint8Array(MAX_LINE_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let length = 0;
    let discard = false;
    const hasPrefix = () => length >= PREFIX_BYTES.length && PREFIX_BYTES.every((value, index) => line[index] === value);
    try {
      while (!op.closing && !op.interruption) {
        const { value, done } = await op.reader.read();
        if (done) {
          if (!op.closing) stop(op, new UsbSetupError('disconnected'));
          return;
        }
        if (!(value instanceof Uint8Array) || value.byteLength > 65536) throw new UsbSetupError('protocol');
        for (const byte of value) {
          if (op.interruption || op.closing) return;
          if (byte === 10) {
            if (!discard && hasPrefix()) {
              const end = length > 0 && line[length - 1] === 13 ? length - 1 : length;
              try { message(op, JSON.parse(decoder.decode(line.subarray(PREFIX_BYTES.length, end)))); }
              catch { stop(op, new UsbSetupError('protocol')); return; }
            }
            length = 0;
            discard = false;
          } else if (!discard) {
            if (length === MAX_LINE_BYTES) {
              if (hasPrefix()) { stop(op, new UsbSetupError('protocol')); return; }
              length = 0;
              discard = true;
            } else line[length++] = byte;
          }
        }
      }
    } catch (error) {
      if (!op.closing) stop(op, error instanceof UsbSetupError ? error : new UsbSetupError('disconnected'));
    }
  }

  async function write(op, value) {
    check(op);
    // An empty line also releases the firmware's bounded discard mode after
    // an earlier program left an incomplete or oversized serial command.
    const encoded = encoder.encode(`\n${PREFIX}${JSON.stringify(value)}\n`);
    let writing;
    try {
      if (encoded.length > MAX_LINE_BYTES) throw new UsbSetupError('protocol');
      writing = Promise.resolve(op.writer.write(encoded));
      writing.then(() => encoded.fill(0), () => encoded.fill(0));
      await Promise.race([writing, op.stopped]);
    } catch (error) {
      throw error instanceof UsbSetupError ? error : new UsbSetupError('disconnected');
    } finally {
      // Do not mutate a byte buffer while the native stream still owns it.
      // On cancellation, cleanup aborts the writer; the handler above then
      // clears the extra encoded copy as soon as that write actually settles.
      if (!writing) encoded.fill(0);
    }
  }

  async function exchange(op, wait, payload) {
    const writing = write(op, payload);
    // A silent/disconnected device can stall a write as well as its reply.
    // The response timeout must still be able to end the operation.
    return Promise.race([writing.then(() => wait.promise), wait.promise, op.stopped]);
  }

  async function handshake(op) {
    const deadline = clock.now() + handshakeTimeoutMs;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      check(op);
      const remaining = deadline - clock.now();
      if (remaining <= 0) break;
      const requestId = id();
      const wait = reply(op, 'ready', requestId, null, Math.min(Math.ceil(handshakeTimeoutMs / 3), remaining));
      try { await exchange(op, wait, { type: 'hello', id: requestId }); return; }
      catch (error) {
        wait.finish(error);
        check(op);
        if (!(error instanceof UsbSetupError) || error.code !== 'firmware') throw error;
      }
    }
    throw new UsbSetupError('firmware');
  }

  async function settleCleanup(op, promise) {
    let deadline;
    try {
      await Promise.race([
        Promise.resolve(promise).catch(() => {}),
        new Promise((resolve) => { deadline = timer(op, resolve, 1000); }),
      ]);
    } finally { clearTimer(op, deadline); }
  }

  async function cleanup(op) {
    op.closing = true;
    // Release any write still awaiting a native browser promise. Its actual
    // byte buffer is cleared when the native write/abort eventually settles.
    if (!op.interruption) op.rejectStopped(new UsbSetupError('cancelled'));
    op.wait?.finish(new UsbSetupError('cancelled'));
    for (const value of op.timers) clock.clearTimeout(value);
    op.timers.clear();
    if (op.reader) {
      try { await settleCleanup(op, op.reader.cancel()); } catch {}
      try { op.reader.releaseLock(); } catch {}
    }
    if (op.writer) {
      try { await settleCleanup(op, op.writer.abort()); } catch {}
      try { op.writer.releaseLock(); } catch {}
    }
    if (op.port && op.opened) {
      try { await settleCleanup(op, op.port.close()); } catch {}
    }
    for (const value of op.timers) clock.clearTimeout(value);
    op.timers.clear();
  }

  async function operate(command, input) {
      if (current) throw new UsbSetupError('busy');
      let config;
      try {
        if (typeof navigatorSerial?.requestPort !== 'function') throw new UsbSetupError('unsupported');
        if (command === 'configure') config = inputConfig(input);
      } catch (error) {
        const safe = error instanceof UsbSetupError ? error : new UsbSetupError('protocol');
        notify(safe.code, safe.message, 'error');
        throw safe;
      }
      const op = { timers: new Set(), closing: false, opened: false };
      op.stopped = new Promise((_, reject) => { op.rejectStopped = reject; });
      op.stopped.catch(() => {});
      current = op;
      busy(true);
      let phase = 'choose';
      try {
        notify('choose', 'Choose the Cardputer USB port in the browser prompt.');
        // This is called directly from the form's submit gesture. Never call
        // requestPort on load, discover saved ports, or silently authorize one.
        op.port = await Promise.race([
          navigatorSerial.requestPort({ filters: FILTERS }), op.stopped,
        ]);
        check(op);
        phase = 'open';
        const openTimer = timer(op, () => stop(op, new UsbSetupError('port_busy')), handshakeTimeoutMs);
        const opening = Promise.resolve(op.port.open({ baudRate: 115200, bufferSize: MAX_LINE_BYTES }));
        opening.then(() => {
          op.opened = true;
          // Cancellation can race the browser's native open operation.
          if (op.closing) Promise.resolve(op.port.close()).catch(() => {});
        }, () => {});
        await Promise.race([opening, op.stopped]);
        check(op);
        await Promise.race([
          op.port.setSignals({ dataTerminalReady: true, requestToSend: false }), op.stopped,
        ]);
        clearTimer(op, openTimer);
        check(op);
        if (!op.port.readable || !op.port.writable) throw new UsbSetupError('port_busy');
        op.reader = op.port.readable.getReader();
        op.writer = op.port.writable.getWriter();
        op.readTask = read(op);
        phase = 'handshake';
        notify('checking', 'Checking the Cardputer firmware. Keep its setup screen open.');
        await handshake(op);
        check(op);
        if (command === 'open_setup') {
          phase = 'open_setup';
          notify('opening_setup', 'Asking the Cardputer to open its setup screen.');
          const requestId = id();
          const wait = reply(op, 'open_setup', requestId, null, handshakeTimeoutMs);
          const result = await exchange(op, wait, { type: 'open_setup', id: requestId });
          notify(result.state, result.state === 'setup_open'
            ? 'Cardputer setup is open. Paste your key and click Send.'
            : 'Cardputer is restarting into setup. Wait for its setup screen, then click Send.', 'success');
          return result;
        }
        phase = 'configure';
        notify('sending', 'Sending directly over USB. Your key is not uploaded by this page.');
        const requestId = id();
        const wait = reply(op, 'configure', requestId, config.provider, handshakeTimeoutMs);
        const result = await exchange(op, wait, { type: 'configure', id: requestId, ...config });
        config.apiKey = '';
        try { onSaved(result); } catch {}
        notify('saved', 'Saved on the Cardputer. Continue with the instructions on its screen.', 'success');
        return result;
      } catch (error) {
        let safe;
        if (error instanceof UsbSetupError) safe = error;
        else if (phase === 'choose' && error?.name === 'NotFoundError') safe = new UsbSetupError('chooser_cancelled');
        else if (phase === 'choose' && ['SecurityError', 'NotAllowedError'].includes(error?.name)) safe = new UsbSetupError('permission');
        else if (phase === 'open') safe = new UsbSetupError('port_busy');
        else safe = new UsbSetupError('disconnected');
        notify(safe.code, safe.message, 'error');
        throw safe;
      } finally {
        if (config) config.apiKey = '';
        await cleanup(op);
        if (current === op) current = undefined;
        busy(false);
      }
  }

  return {
    get supported() { return typeof navigatorSerial?.requestPort === 'function'; },
    get busy() { return Boolean(current); },
    send: (input) => operate('configure', input),
    openSetup: () => operate('open_setup'),
    cancel() {
      if (!current) return false;
      stop(current, new UsbSetupError('cancelled'));
      return true;
    },
  };
}

export function bindUsbSetup(document = globalThis.document, options = {}) {
  if (globalThis.location?.pathname === '/settings') {
    const title = document?.getElementById('setup-page-title');
    const intro = document?.getElementById('setup-page-intro');
    if (title) title.textContent = 'Cardputer device settings';
    if (intro) intro.textContent = 'Open setup, paste a new key, and send it directly to your Cardputer.';
    for (const id of ['install-panel', 'wifi-panel']) {
      const panel = document?.getElementById(id);
      if (panel) panel.hidden = true;
    }
    const step = document?.getElementById('provider-step-number');
    if (step) step.textContent = '1';
  }
  const form = document?.getElementById('usb-setup-form');
  if (!form || form.dataset.usbSetupBound === 'true') return null;
  const get = (id) => document.getElementById(id);
  const provider = get('usb-provider');
  const apiKey = get('usb-api-key');
  const reference = get('usb-reference');
  const referenceField = get('usb-reference-field');
  const referenceLabel = get('usb-reference-label');
  const keyLabel = get('usb-api-key-label');
  const keyLink = get('usb-provider-key-link');
  const submit = get('usb-send');
  const openSetup = get('usb-open-setup');
  const status = get('usb-status');
  if (![provider, apiKey, reference, referenceField, referenceLabel, submit, status].every(Boolean)) return null;
  form.dataset.usbSetupBound = 'true';
  let active = false;
  const setup = createUsbSetup({
    ...options,
    onStatus(update) {
      status.textContent = update.message;
      status.dataset.state = update.kind;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      try { options.onStatus?.(update); } catch {}
    },
    onBusy(value) { active = value; updateFields(); try { options.onBusy?.(value); } catch {} },
    onSaved(result) { apiKey.value = ''; try { options.onSaved?.(result); } catch {} },
  });
  function updateFields() {
    const choice = PROVIDERS[provider.value] || PROVIDERS.gemini;
    referenceField.hidden = !choice.reference;
    referenceLabel.textContent = choice.reference || 'Agent or Config ID';
    reference.placeholder = provider.value === 'elevenlabs' ? 'agent_…' : 'Your Hume Config ID';
    reference.required = Boolean(choice.reference);
    reference.disabled = active || !choice.reference;
    if (keyLabel) keyLabel.textContent = choice.label;
    if (keyLink) { keyLink.href = choice.link; keyLink.textContent = choice.linkText; }
    provider.disabled = active;
    apiKey.disabled = active;
    submit.disabled = active || !setup.supported;
    submit.textContent = active ? 'Waiting for Cardputer…' : 'Send to Cardputer';
    if (openSetup) openSetup.disabled = active || !setup.supported;
  }
  if (!Object.hasOwn(PROVIDERS, provider.value)) provider.value = 'gemini';
  provider.addEventListener('change', () => {
    apiKey.value = '';
    reference.value = '';
    updateFields();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (active || (typeof form.reportValidity === 'function' && !form.reportValidity())) return;
    void setup.send({ provider: provider.value, apiKey: apiKey.value, referenceId: reference.value }).catch(() => {});
  });
  openSetup?.addEventListener('click', (event) => {
    event.preventDefault();
    if (!active) void setup.openSetup().catch(() => {});
  });
  document.defaultView?.addEventListener('pagehide', () => { apiKey.value = ''; setup.cancel(); });
  updateFields();
  if (setup.supported) {
    status.textContent = 'Ready. Paste your key, then click Send to Cardputer.';
    status.dataset.state = 'ready';
  } else {
    status.textContent = ERRORS.unsupported;
    status.dataset.state = 'error';
  }
  return setup;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bindUsbSetup(), { once: true });
  else bindUsbSetup();
}

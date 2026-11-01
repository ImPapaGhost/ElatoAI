const REQUEST_LABEL = 'CardputerVoice wireless request v1';
const RESPONSE_LABEL = 'CardputerVoice wireless response v1';
const PORT = 8080;
const MAX_JSON_BYTES = 8192;
const MAX_PLAIN_BYTES = 2048;
const DB_NAME = 'cardputer-voice-wireless';
const STORE_NAME = 'devices';
const PROVIDERS = new Set(['gemini', 'elevenlabs', 'hume']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MESSAGES = Object.freeze({
  unavailable: 'Wireless setup needs secure browser cryptography. You can still use USB.',
  storage: 'This browser could not save or read its wireless pairing. Continue with USB or try desktop Chrome or Edge.',
  pairing: 'Pair this browser with the Cardputer over USB first.',
  metadata: 'The USB pairing details could not be verified. Pair the Cardputer again over USB.',
  address: 'Wireless setup only accepts this paired Cardputer on your local network, using port 8080.',
  busy: 'A wireless setup request is already running. Finish that request first.',
  cancelled: 'Wireless setup was cancelled.',
  network: 'Could not reach the Cardputer. Allow local network access, check that both devices use the same Wi-Fi, or use USB.',
  protocol: 'The Cardputer returned an unexpected wireless reply. Update its firmware or use USB.',
  wrong_device: 'That address did not answer as your paired Cardputer. Check its Wi-Fi or pair again over USB.',
  authentication: 'The device reply could not be verified. Pair this browser with the Cardputer again over USB.',
  replay: 'The Cardputer returned a repeated wireless challenge. Try again or use USB.',
  provider: 'Choose Gemini, ElevenLabs, or Hume.',
  api_key: 'Paste the API key from the selected provider.',
  reference: 'Enter the existing Agent ID or Config ID for this provider.',
  not_in_setup: 'Open setup on the Cardputer first, then send the key again.',
  device_busy: 'The Cardputer is already waiting for a setup confirmation. Finish or cancel that prompt first.',
  confirmation_timeout: 'Confirmation timed out. Send again and press Enter on the Cardputer to approve.',
  device_cancelled: 'Setup was cancelled on the Cardputer. Its previous settings were kept.',
  unknown_operation: 'The Cardputer no longer has that confirmation request. Send the settings again.',
  save_failed: 'The Cardputer could not save the settings. Check its screen and try again.',
});
const realClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (value) => clearTimeout(value),
};

class WirelessSetupError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.protocol);
    this.name = 'WirelessSetupError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'protocol';
  }
}

function cryptoReady(crypto) {
  if (!crypto?.subtle?.digest || !crypto.subtle.importKey || !crypto.subtle.encrypt ||
      !crypto.subtle.decrypt || typeof crypto.getRandomValues !== 'function') {
    throw new WirelessSetupError('unavailable');
  }
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value, length, maximum = length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) ||
      value.length > Math.ceil(maximum * 4 / 3) || value.length % 4 === 1) {
    throw new WirelessSetupError('protocol');
  }
  let bytes;
  try {
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
    bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch { throw new WirelessSetupError('protocol'); }
  if (bytes.length < length || bytes.length > maximum || toBase64Url(bytes) !== value) {
    throw new WirelessSetupError('protocol');
  }
  return bytes;
}

function privateIpv4(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function metadata(value) {
  if (!value || typeof value !== 'object' || !/^[0-9A-F]{12}$/.test(value.deviceId || '')) {
    throw new WirelessSetupError('metadata');
  }
  const host = `cardputer-${value.deviceId.slice(-6).toLowerCase()}.local`;
  if (value.host !== host || !/^cardputer-[a-f0-9]{6}\.local$/.test(value.host) ||
      (value.port !== undefined && value.port !== PORT)) throw new WirelessSetupError('address');
  const ip = value.ip == null || value.ip === '' || value.ip === '0.0.0.0' ? null : value.ip;
  if (ip !== null && !privateIpv4(ip)) throw new WirelessSetupError('address');
  return { deviceId: value.deviceId, host, ip, port: PORT };
}

function validKey(value, usage) {
  return value?.type === 'secret' && value.extractable === false &&
    value.algorithm?.name === 'AES-GCM' && value.algorithm?.length === 256 &&
    value.usages?.length === 1 && value.usages[0] === usage;
}

function idbStorage(indexedDB = globalThis.indexedDB) {
  async function database() {
    if (!indexedDB?.open) throw new WirelessSetupError('storage');
    return new Promise((resolve, reject) => {
      let rejected = false;
      let request;
      try { request = indexedDB.open(DB_NAME, 1); }
      catch { reject(new WirelessSetupError('storage')); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'deviceId' });
      };
      request.onsuccess = () => {
        if (rejected) request.result.close(); else resolve(request.result);
      };
      request.onerror = request.onblocked = () => { rejected = true; reject(new WirelessSetupError('storage')); };
    });
  }
  async function transact(mode, action) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        let request;
        let tx;
        try { tx = db.transaction(STORE_NAME, mode); request = action(tx.objectStore(STORE_NAME)); }
        catch { reject(new WirelessSetupError('storage')); return; }
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = tx.onabort = () => reject(new WirelessSetupError('storage'));
      });
    } finally { db.close(); }
  }
  return {
    get: (id) => transact('readonly', (store) => store.get(id)),
    list: () => transact('readonly', (store) => store.getAll()),
    put: (record) => transact('readwrite', (store) => store.put(record)),
    delete: (id) => transact('readwrite', (store) => store.delete(id)),
  };
}

/** Persist nonextractable CryptoKeys, never the USB control secret or API key. */
export async function pairDevice(paired, { crypto = globalThis.crypto, storage = idbStorage() } = {}) {
  cryptoReady(crypto);
  const device = metadata(paired);
  if (paired.type !== 'paired') throw new WirelessSetupError('metadata');
  let secret;
  const materials = [];
  try {
    secret = fromBase64Url(paired.controlSecret, 32);
    const derive = async (label, usage) => {
      const suffix = encoder.encode(label);
      const material = new Uint8Array(secret.length + suffix.length);
      material.set(secret);
      material.set(suffix, secret.length);
      materials.push(material);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
      materials.push(digest);
      return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, [usage]);
    };
    const requestKey = await derive(REQUEST_LABEL, 'encrypt');
    const responseKey = await derive(RESPONSE_LABEL, 'decrypt');
    await storage.put({ deviceId: device.deviceId, host: device.host, ip: device.ip, requestKey, responseKey });
    return device;
  } catch (error) {
    if (error instanceof WirelessSetupError && error.code === 'protocol') throw new WirelessSetupError('metadata');
    throw error instanceof WirelessSetupError ? error : new WirelessSetupError('storage');
  } finally {
    secret?.fill(0);
    for (const material of materials) material.fill(0);
  }
}

export async function listPairedDevices({ storage = idbStorage() } = {}) {
  try {
    const records = await storage.list();
    if (!Array.isArray(records)) throw new WirelessSetupError('storage');
    return records.flatMap((record) => {
      try {
        if (!validKey(record.requestKey, 'encrypt') || !validKey(record.responseKey, 'decrypt')) return [];
        return [metadata(record)];
      } catch { return []; }
    });
  } catch (error) { throw error instanceof WirelessSetupError ? error : new WirelessSetupError('storage'); }
}

export async function forgetDevice(deviceId, { storage = idbStorage() } = {}) {
  if (!/^[0-9A-F]{12}$/.test(deviceId || '')) throw new WirelessSetupError('metadata');
  try { await storage.delete(deviceId); }
  catch { throw new WirelessSetupError('storage'); }
}

function providerConfig(value) {
  const provider = value?.provider || 'gemini';
  if (!PROVIDERS.has(provider)) throw new WirelessSetupError('provider');
  const apiKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
  if (!/^[A-Za-z0-9_.-]{16,256}$/.test(apiKey)) throw new WirelessSetupError('api_key');
  const referenceId = provider === 'gemini' ? '' : typeof value?.referenceId === 'string' ? value.referenceId.trim() : '';
  if (provider !== 'gemini' && !/^[A-Za-z0-9_.-]{1,128}$/.test(referenceId)) throw new WirelessSetupError('reference');
  return { type: 'configure', provider, apiKey, referenceId, voice: 'Aoede' };
}

function safeDeviceError(code) {
  const codes = {
    not_in_setup: 'not_in_setup', busy: 'device_busy', unknown_operation: 'unknown_operation',
    expired: 'confirmation_timeout', confirmation_timeout: 'confirmation_timeout',
    invalid_provider: 'provider', invalid_key: 'api_key', invalid_api_key: 'api_key',
    invalid_reference: 'reference', save_failed: 'save_failed', storage_failed: 'save_failed',
  };
  return new WirelessSetupError(Object.hasOwn(codes, code) ? codes[code] : 'protocol');
}

async function jsonBody(response) {
  const announced = response.headers?.get?.('content-length');
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > MAX_JSON_BYTES)) throw new WirelessSetupError('protocol');
  let body;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let count = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || count + value.length > MAX_JSON_BYTES) throw new WirelessSetupError('protocol');
        chunks.push(value);
        count += value.length;
      }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      body = decoder.decode(bytes);
    } finally {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  } else if (typeof response.text === 'function') {
    body = await response.text();
    if (encoder.encode(body).length > MAX_JSON_BYTES) throw new WirelessSetupError('protocol');
  } else throw new WirelessSetupError('protocol');
  try { return JSON.parse(body); }
  catch { throw new WirelessSetupError('protocol'); }
}

/** No LAN requests occur until send(), openSetup(), or status() is called. */
export function createWirelessSetup({
  device, crypto = globalThis.crypto, storage = idbStorage(), fetchImpl = globalThis.fetch,
  clock = realClock, pollIntervalMs = 1200, confirmationTimeoutMs = 60000, requestTimeoutMs = 10000,
  onStatus = () => {}, onSaved = () => {}, onBusy = () => {},
} = {}) {
  const deviceId = typeof device === 'string' ? device : metadata(device).deviceId;
  if (!/^[0-9A-F]{12}$/.test(deviceId || '')) throw new WirelessSetupError('metadata');
  let current;
  const challenges = new Set();

  function notify(code, message, kind = 'working') { try { onStatus({ code, message, kind }); } catch {} }
  function busy(value) { try { onBusy(value); } catch {} }
  function stopped(op) { if (op.error) throw op.error; }
  function stop(op, error) {
    if (op.error) return;
    op.error = error;
    op.abort.abort();
    op.rejectStopped(error);
  }
  function arm(op, timeout, code) {
    if (op.timer !== undefined) clock.clearTimeout(op.timer);
    op.deadline = clock.now() + timeout;
    op.timer = clock.setTimeout(() => stop(op, new WirelessSetupError(code)), timeout);
  }

  async function record(op) {
    let stored;
    try { stored = await Promise.race([storage.get(deviceId), op.stopped]); }
    catch (error) { throw error instanceof WirelessSetupError ? error : new WirelessSetupError('storage'); }
    stopped(op);
    if (!stored) throw new WirelessSetupError('pairing');
    const meta = metadata(stored);
    if (meta.deviceId !== deviceId || !validKey(stored.requestKey, 'encrypt') || !validKey(stored.responseKey, 'decrypt')) {
      throw new WirelessSetupError('pairing');
    }
    return { ...meta, requestKey: stored.requestKey, responseKey: stored.responseKey };
  }

  async function network(op, url, options) {
    stopped(op);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    op.abort.signal.addEventListener('abort', cancel, { once: true });
    let timeout;
    try {
      const request = (async () => {
        const response = await fetchImpl(url, {
          ...options, credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'cors',
          targetAddressSpace: 'local', referrerPolicy: 'no-referrer', signal: abort.signal,
        });
        if (!response?.ok) throw new WirelessSetupError('network');
        return jsonBody(response);
      })();
      return await Promise.race([
        request,
        op.stopped,
        new Promise((_, reject) => {
          timeout = clock.setTimeout(() => { abort.abort(); reject(new WirelessSetupError('network')); },
            Math.max(1, Math.min(requestTimeoutMs, op.deadline - clock.now())));
        }),
      ]);
    } catch (error) {
      stopped(op);
      throw error instanceof WirelessSetupError ? error : new WirelessSetupError('network');
    } finally {
      if (timeout !== undefined) clock.clearTimeout(timeout);
      op.abort.signal.removeEventListener('abort', cancel);
    }
  }

  async function challenge(op, paired) {
    const hosts = [paired.host, ...(paired.ip ? [paired.ip] : [])];
    for (let index = 0; index < hosts.length; index += 1) {
      try {
        const origin = `http://${hosts[index]}:${PORT}`;
        const answer = await network(op, `${origin}/setup/challenge`, { method: 'GET', headers: { Accept: 'application/json' } });
        if (answer?.protocol !== 1 || answer.deviceId !== paired.deviceId) throw new WirelessSetupError('wrong_device');
        fromBase64Url(answer.challenge, 16);
        if (answer.expiresIn !== 15) throw new WirelessSetupError('protocol');
        if (challenges.has(answer.challenge)) throw new WirelessSetupError('replay');
        return { origin, value: answer.challenge };
      } catch (error) {
        stopped(op);
        if (!(error instanceof WirelessSetupError) || error.code !== 'network' || index === hosts.length - 1) throw error;
      }
    }
    throw new WirelessSetupError('network');
  }

  async function request(op, paired, plain) {
    const selected = await challenge(op, paired);
    stopped(op);
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = (direction) => encoder.encode(`CVWIFI1|${direction}|${paired.deviceId}|${selected.value}|${id}`);
    const plaintext = encoder.encode(JSON.stringify(plain));
    if (plaintext.length > MAX_PLAIN_BYTES) throw new WirelessSetupError('protocol');
    let encrypted;
    try {
      encrypted = new Uint8Array(await Promise.race([
        crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad('request'), tagLength: 128 }, paired.requestKey, plaintext),
        op.stopped,
      ]));
    } catch (error) {
      stopped(op);
      throw error instanceof WirelessSetupError ? error : new WirelessSetupError('authentication');
    } finally { plaintext.fill(0); }
    stopped(op);
    challenges.add(selected.value);
    if (challenges.size > 256) challenges.delete(challenges.values().next().value);
    const envelope = { protocol: 1, deviceId: paired.deviceId, id, challenge: selected.value,
      iv: toBase64Url(iv), ciphertext: toBase64Url(encrypted) };
    encrypted.fill(0);
    const answer = await network(op, `${selected.origin}/setup/command`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(envelope),
    });
    if (answer?.protocol !== 1 || answer.deviceId !== paired.deviceId || answer.id !== id || answer.challenge !== selected.value) {
      throw new WirelessSetupError('authentication');
    }
    let decrypted;
    let result;
    try {
      const responseIv = fromBase64Url(answer.iv, 12);
      const ciphertext = fromBase64Url(answer.ciphertext, 16, MAX_PLAIN_BYTES + 16);
      decrypted = new Uint8Array(await Promise.race([
        crypto.subtle.decrypt({ name: 'AES-GCM', iv: responseIv, additionalData: aad('response'), tagLength: 128 }, paired.responseKey, ciphertext),
        op.stopped,
      ]));
      if (decrypted.length > MAX_PLAIN_BYTES) throw new Error();
      result = JSON.parse(decoder.decode(decrypted));
    } catch (error) {
      stopped(op);
      throw error instanceof WirelessSetupError && error.code === 'cancelled' ? error : new WirelessSetupError('authentication');
    } finally { decrypted?.fill(0); }
    if (!result || result.id !== id || !['setup_open', 'restarting', 'pending', 'saved', 'cancelled', 'error'].includes(result.type)) {
      throw new WirelessSetupError('authentication');
    }
    const operationId = plain.type === 'configure' ? id : plain.operationId;
    if (operationId && result.operationId !== operationId) throw new WirelessSetupError('authentication');
    if (result.type === 'error') throw safeDeviceError(result.code);
    return { type: result.type, id, ...(operationId ? { operationId } : {}) };
  }

  async function delay(op) {
    let timeout;
    try {
      await Promise.race([
        op.stopped,
        new Promise((resolve) => { timeout = clock.setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, op.deadline - clock.now()))); }),
      ]);
    } finally { if (timeout !== undefined) clock.clearTimeout(timeout); }
    stopped(op);
  }

  async function run(command, input) {
    if (current) throw new WirelessSetupError('busy');
    cryptoReady(crypto);
    const config = command === 'configure' ? providerConfig(input) : null;
    if (command === 'status' && !/^[a-f0-9]{24}$/.test(input || '')) throw new WirelessSetupError('protocol');
    const op = { abort: new AbortController() };
    op.stopped = new Promise((_, reject) => { op.rejectStopped = reject; });
    op.stopped.catch(() => {});
    arm(op, 60000, 'network');
    current = op;
    busy(true);
    try {
      const paired = await record(op);
      notify('connecting', 'Connecting to your paired Cardputer on this Wi-Fi network. Allow local network access if asked.');
      if (command === 'open_setup') {
        const result = await request(op, paired, { type: 'open_setup' });
        if (!['setup_open', 'restarting'].includes(result.type)) throw new WirelessSetupError('protocol');
        notify(result.type, result.type === 'setup_open'
          ? 'Cardputer setup is open. Paste your key and click Send.'
          : 'Cardputer is restarting into setup. Wait for its setup screen, then click Send.', 'success');
        return { state: result.type };
      }
      if (command === 'status') {
        const result = await request(op, paired, { type: 'status', operationId: input });
        if (!['pending', 'saved', 'cancelled'].includes(result.type)) throw new WirelessSetupError('protocol');
        return result;
      }
      let result = await request(op, paired, config);
      if (result.type === 'pending') {
        arm(op, confirmationTimeoutMs, 'confirmation_timeout');
        notify('confirm', 'Press Enter on the Cardputer to approve saving this key. Press Esc there to cancel.');
        const operationId = result.operationId;
        while (result.type === 'pending') {
          await delay(op);
          result = await request(op, paired, { type: 'status', operationId });
        }
      }
      if (result.type === 'cancelled') throw new WirelessSetupError('device_cancelled');
      if (result.type !== 'saved') throw new WirelessSetupError('protocol');
      const saved = { type: 'saved', deviceId: paired.deviceId, operationId: result.operationId, provider: config.provider };
      try { onSaved(saved); } catch {}
      notify('saved', 'Saved wirelessly on the Cardputer. Continue with the instructions on its screen.', 'success');
      return saved;
    } catch (error) {
      const safe = error instanceof WirelessSetupError ? error : new WirelessSetupError('protocol');
      notify(safe.code, safe.message, 'error');
      throw safe;
    } finally {
      if (config) config.apiKey = '';
      if (op.timer !== undefined) clock.clearTimeout(op.timer);
      op.abort.abort();
      if (current === op) current = undefined;
      busy(false);
    }
  }

  return {
    get busy() { return Boolean(current); },
    send: (config) => run('configure', config),
    openSetup: () => run('open_setup'),
    status: (operationId) => run('status', operationId),
    cancel() { if (!current) return false; stop(current, new WirelessSetupError('cancelled')); return true; },
  };
}

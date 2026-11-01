import { createHash, randomBytes } from 'node:crypto';

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_COLUMNS = 'id,owner_id,name,mac,enabled,created_at,revoked_at';
const DEFAULT_SETTINGS = {
  character_name: 'Cardputer',
  system_prompt: 'You are a friendly conversational companion. Speak naturally and keep replies to one to three short sentences.',
  voice_name: 'Aoede',
  volume: 70,
};

function text(value, name, limit, { empty = false } = {}) {
  if (typeof value !== 'string') throw new StoreError(400, `${name} must be text.`);
  const result = value.trim();
  if ((!empty && !result) || result.length > limit) {
    throw new StoreError(400, `${name} must contain ${empty ? '0' : '1'} to ${limit} characters.`);
  }
  return result;
}

function uuid(value, name = 'ID') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new StoreError(400, `Invalid ${name}.`);
  return value;
}

function normalizeMac(value) {
  const result = text(value, 'Wi-Fi MAC address', 17).replaceAll('-', ':').toUpperCase();
  if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(result)) {
    throw new StoreError(400, 'Use the station Wi-Fi MAC address, for example AA:BB:CC:DD:EE:FF.');
  }
  return result;
}

function publicDevice(record) {
  return Object.fromEntries(DEVICE_COLUMNS.split(',').map((key) => [key, record[key]]));
}

function settingsInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError(400, 'Invalid character settings.');
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new StoreError(400, 'Unknown character setting.');
  const result = {
    character_name: text(value.character_name, 'Character name', 80),
    system_prompt: text(value.system_prompt, 'Character instructions', 8000),
    voice_name: text(value.voice_name, 'Voice name', 48),
    volume: value.volume,
  };
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result.voice_name)) throw new StoreError(400, 'Invalid voice name.');
  if (!Number.isInteger(result.volume) || result.volume < 0 || result.volume > 100) {
    throw new StoreError(400, 'Volume must be a whole number from 0 to 100.');
  }
  return result;
}

/** All Supabase access is server-side. Never expose the service-role key to a browser. */
export function createStore(config, { fetchImpl = fetch } = {}) {
  const ownerEmail = String(config.ownerEmail || '').trim().toLowerCase();
  const baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const dailySeconds = config.dailyVoiceSeconds ?? 600;
  const sessionSeconds = config.sessionSeconds ?? 240;
  const ownerCache = new Map();

  function configured({ database = false } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { /* Fail closed below. */ }
    const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash ||
        !config.supabaseAnonKey || !ownerEmail || !ownerEmail.includes('@') ||
        (database && !config.supabaseServiceRoleKey)) {
      throw new StoreError(503, 'The private Supabase backend is not configured.');
    }
    if (!Number.isInteger(dailySeconds) || dailySeconds < 60 || dailySeconds > 1800 ||
        !Number.isInteger(sessionSeconds) || sessionSeconds < 20 || sessionSeconds > 240) {
      throw new StoreError(503, 'The server voice limits are invalid.');
    }
  }

  function mapFailure(status, body) {
    const message = typeof body?.message === 'string' ? body.message : '';
    if (message === 'daily_voice_limit') return new StoreError(429, 'The daily voice allowance has been used.');
    if (message === 'voice_session_active') return new StoreError(409, 'A voice session is already active.');
    if (message === 'device_unavailable') return new StoreError(401, 'This device is unavailable.');
    if (message === 'lease_not_found') return new StoreError(404, 'Voice session not found.');
    const authCode = body?.error_code || body?.code || body?.error;
    if (['invalid_credentials', 'invalid_grant', 'refresh_token_not_found', 'refresh_token_already_used'].includes(authCode)) {
      return new StoreError(401, 'Authentication failed. Check your credentials or sign in again.');
    }
    if (authCode === 'email_not_confirmed') return new StoreError(401, 'Confirm your email before signing in.');
    if (body?.code === '23505') return new StoreError(409, 'Only one enabled Cardputer is allowed. Revoke the existing device first.');
    if (status === 401 || status === 403) return new StoreError(401, 'Authentication failed. Check your credentials or sign in again.');
    if (status === 429) return new StoreError(429, 'Supabase is rate limiting requests. Try again later.');
    return new StoreError(502, 'The private database request failed.');
  }

  async function request(path, { method = 'GET', body, token, service = false, prefer } = {}) {
    configured({ database: service });
    const apiKey = service ? config.supabaseServiceRoleKey : config.supabaseAnonKey;
    const headers = { apikey: apiKey, 'Content-Type': 'application/json' };
    if (service || token) headers.Authorization = `Bearer ${service ? apiKey : token}`;
    if (prefer) headers.Prefer = prefer;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new StoreError(503, 'Cannot reach the private Supabase backend.');
    }
    let data = null;
    try { data = await response.json(); } catch { /* 204 / empty response. */ }
    if (!response.ok) throw mapFailure(response.status, data);
    return data;
  }

  function query(table, params = {}) {
    return `/rest/v1/${table}?${new URLSearchParams(params)}`;
  }

  async function assertOwner(ownerId) {
    configured({ database: true });
    uuid(ownerId, 'owner ID');
    if ((ownerCache.get(ownerId) || 0) > Date.now()) return;
    const user = await request(`/auth/v1/admin/users/${ownerId}`, { service: true });
    if (user?.id !== ownerId || String(user?.email || '').toLowerCase() !== ownerEmail) {
      throw new StoreError(403, 'This service is private to its configured owner.');
    }
    ownerCache.set(ownerId, Date.now() + 60000);
  }

  async function authenticateOwner(accessToken) {
    configured();
    if (typeof accessToken !== 'string' || accessToken.length < 16 || accessToken.length > 8192 || /\s/.test(accessToken)) {
      throw new StoreError(401, 'Sign in to the private dashboard.');
    }
    const user = await request('/auth/v1/user', { token: accessToken });
    if (!UUID.test(user?.id || '') || String(user?.email || '').toLowerCase() !== ownerEmail) {
      throw new StoreError(403, 'This service is private to its configured owner.');
    }
    ownerCache.set(user.id, Date.now() + 60000);
    return { id: user.id, email: user.email };
  }

  function sessionResult(session) {
    if (typeof session?.access_token !== 'string' || typeof session?.refresh_token !== 'string' ||
        !Number.isFinite(session.expires_in) || session.expires_in <= 0) {
      throw new StoreError(502, 'Supabase returned an invalid sign-in session.');
    }
    return { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in };
  }

  async function signIn(email, password) {
    configured();
    if (text(email, 'Email', 254).toLowerCase() !== ownerEmail) {
      throw new StoreError(403, 'This service is private to its configured owner.');
    }
    if (typeof password !== 'string' || !password || password.length > 1024) throw new StoreError(400, 'Enter your password.');
    const result = sessionResult(await request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email: ownerEmail, password },
    }));
    await authenticateOwner(result.access_token);
    return result;
  }

  async function refresh(refreshToken) {
    configured();
    if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 8192) throw new StoreError(401, 'Sign in again.');
    const result = sessionResult(await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: refreshToken },
    }));
    await authenticateOwner(result.access_token);
    return result;
  }

  async function signOut(accessToken) {
    const owner = await authenticateOwner(accessToken);
    await request('/auth/v1/logout', { method: 'POST', token: accessToken });
    ownerCache.delete(owner.id);
  }

  async function ensureSettings(ownerId) {
    const params = { owner_id: `eq.${ownerId}`, select: '*', limit: '1' };
    const existing = await request(query('cv_settings', params), { service: true });
    if (existing?.[0]) return existing[0];
    const inserted = await request(query('cv_settings', { on_conflict: 'owner_id' }), {
      method: 'POST', service: true, body: { owner_id: ownerId, ...DEFAULT_SETTINGS },
      prefer: 'resolution=ignore-duplicates,return=representation',
    });
    if (inserted?.[0]) return inserted[0];
    const concurrent = await request(query('cv_settings', params), { service: true });
    if (!concurrent?.[0]) throw new StoreError(502, 'Cannot initialize character settings.');
    return concurrent[0];
  }

  async function getDashboard(ownerId) {
    await assertOwner(ownerId);
    const date = new Date().toISOString().slice(0, 10);
    const [settings, devices, usage, messages] = await Promise.all([
      ensureSettings(ownerId),
      request(query('cv_devices', { owner_id: `eq.${ownerId}`, select: DEVICE_COLUMNS, order: 'created_at.desc', limit: '25' }), { service: true }),
      request(query('cv_usage', { owner_id: `eq.${ownerId}`, usage_date: `eq.${date}`, select: 'usage_date,used_seconds', limit: '1' }), { service: true }),
      request(query('cv_messages', { owner_id: `eq.${ownerId}`, select: 'id,device_id,role,content,created_at', order: 'created_at.desc,id.desc', limit: '50' }), { service: true }),
    ]);
    const usedSeconds = usage?.[0]?.used_seconds || 0;
    return {
      settings,
      devices: (devices || []).map(publicDevice),
      usage: { usage_date: date, used_seconds: usedSeconds, limit_seconds: dailySeconds, daily_limit_seconds: dailySeconds, remaining_seconds: Math.max(0, dailySeconds - usedSeconds), session_limit_seconds: sessionSeconds },
      messages: (messages || []).reverse(),
    };
  }

  async function saveSettings(ownerId, settings) {
    await assertOwner(ownerId);
    const values = settingsInput(settings);
    const rows = await request(query('cv_settings', { on_conflict: 'owner_id' }), {
      method: 'POST', service: true, body: { owner_id: ownerId, ...values, updated_at: new Date().toISOString() },
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    if (!rows?.[0]) throw new StoreError(502, 'Cannot save character settings.');
    return rows[0];
  }

  async function createDevice(ownerId, input) {
    await assertOwner(ownerId);
    const name = text(input?.name, 'Device name', 80);
    const mac = normalizeMac(input?.mac);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const rows = await request(query('cv_devices', { select: DEVICE_COLUMNS }), {
      method: 'POST', service: true, body: { owner_id: ownerId, name, mac, token_hash: tokenHash },
      prefer: 'return=representation',
    });
    if (!rows?.[0]) throw new StoreError(502, 'Cannot register the Cardputer.');
    return { device: publicDevice(rows[0]), token };
  }

  async function revokeDevice(ownerId, deviceId) {
    await assertOwner(ownerId);
    uuid(deviceId, 'device ID');
    const rows = await request(query('cv_devices', { id: `eq.${deviceId}`, owner_id: `eq.${ownerId}`, select: DEVICE_COLUMNS }), {
      method: 'PATCH', service: true, body: { enabled: false, revoked_at: new Date().toISOString() },
      prefer: 'return=representation',
    });
    if (!rows?.[0]) throw new StoreError(404, 'Device not found.');
    return publicDevice(rows[0]);
  }

  async function authenticateDevice(token, mac) {
    configured({ database: true });
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new StoreError(401, 'Invalid device credentials.');
    let stationMac;
    try { stationMac = normalizeMac(mac); } catch { throw new StoreError(401, 'Invalid device credentials.'); }
    const rows = await request(query('cv_devices', {
      token_hash: `eq.${createHash('sha256').update(token).digest('hex')}`,
      mac: `eq.${stationMac}`, enabled: 'eq.true', select: 'id,owner_id,mac', limit: '1',
    }), { service: true });
    const device = rows?.[0];
    if (!device || device.mac !== stationMac || !UUID.test(device.id || '') || !UUID.test(device.owner_id || '')) {
      throw new StoreError(401, 'Invalid device credentials.');
    }
    await assertOwner(device.owner_id);
    return { id: device.id, owner_id: device.owner_id, mac: device.mac };
  }

  async function getVoiceContext(device) {
    uuid(device?.id, 'device ID');
    await assertOwner(device?.owner_id);
    const [settings, rows] = await Promise.all([
      ensureSettings(device.owner_id),
      request(query('cv_messages', { owner_id: `eq.${device.owner_id}`, device_id: `eq.${device.id}`, select: 'role,content', order: 'created_at.desc,id.desc', limit: '20' }), { service: true }),
    ]);
    return { settings, history: (rows || []).filter((row) => ['user', 'assistant'].includes(row.role)).reverse().map(({ role, content }) => ({ role, content })) };
  }

  async function reserveSession(device) {
    uuid(device?.id, 'device ID');
    await assertOwner(device?.owner_id);
    const rows = await request('/rest/v1/rpc/cv_reserve_session', {
      method: 'POST', service: true,
      body: { p_owner_id: device.owner_id, p_device_id: device.id, p_daily_seconds: dailySeconds, p_session_seconds: sessionSeconds },
    });
    const lease = rows?.[0];
    if (!UUID.test(lease?.id || '') || !Number.isInteger(lease.max_seconds) || lease.max_seconds < 1 || lease.max_seconds > sessionSeconds || lease.max_seconds > dailySeconds) {
      throw new StoreError(502, 'The database returned an invalid voice reservation.');
    }
    return { id: lease.id, maxSeconds: lease.max_seconds };
  }

  async function finishSession(leaseId, elapsedSeconds) {
    uuid(leaseId, 'voice session ID');
    if (typeof elapsedSeconds !== 'number' || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > 86400) {
      throw new StoreError(400, 'Invalid voice session duration.');
    }
    const leases = await request(query('cv_voice_leases', { id: `eq.${leaseId}`, select: 'owner_id', limit: '1' }), { service: true });
    if (!leases?.[0]) throw new StoreError(404, 'Voice session not found.');
    await assertOwner(leases[0].owner_id);
    await request('/rest/v1/rpc/cv_finish_session', {
      method: 'POST', service: true, body: { p_lease_id: leaseId, p_elapsed_seconds: Math.ceil(elapsedSeconds) },
    });
  }

  async function appendTranscript(ownerId, deviceId, role, content) {
    await assertOwner(ownerId);
    uuid(deviceId, 'device ID');
    if (!['user', 'assistant'].includes(role)) throw new StoreError(400, 'Invalid transcript role.');
    const transcript = text(content, 'Transcript', 12000);
    await request('/rest/v1/rpc/cv_append_transcript', {
      method: 'POST', service: true,
      body: { p_owner_id: ownerId, p_device_id: deviceId, p_role: role, p_content: transcript },
    });
  }

  return { signIn, refresh, signOut, authenticateOwner, getDashboard, saveSettings, createDevice, revokeDevice, authenticateDevice, getVoiceContext, reserveSession, finishSession, appendTranscript };
}

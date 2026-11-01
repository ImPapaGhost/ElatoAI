import { StoreError } from './store.mjs';

export const BYOK_LIMITS = Object.freeze({
  maxSessionSeconds: 240,
  maxActiveSessions: 2,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function upstreamError(status, data) {
  const code = typeof data?.message === 'string' ? data.message : '';
  const known = {
    byok_key_session_active: [409, 'This provider key is already in use.'],
    byok_global_session_limit: [429, 'Both voice sessions are busy. Try again shortly.'],
    byok_lease_not_found: [404, 'Voice session not found.'],
    byok_invalid_fingerprint: [400, 'Invalid provider-key fingerprint.'],
    byok_invalid_elapsed: [400, 'Invalid voice session duration.'],
    byok_invalid_limits: [503, 'The shared voice service is not configured correctly.'],
  };
  if (Object.hasOwn(known, code)) return new StoreError(...known[code]);
  if (status === 401 || status === 403) return new StoreError(503, 'Shared voice accounting is unavailable.');
  if (status === 429) return new StoreError(429, 'The shared service is busy. Try again shortly.');
  return new StoreError(502, 'The shared voice accounting request failed.');
}

/**
 * Service-only concurrency and usage store. The caller hashes provider + key before calling
 * reserveSession; neither plaintext provider keys nor device identifiers enter
 * this module. Model authentication remains the voice bridge's responsibility.
 */
export function createByokStore(config, { fetchImpl = fetch } = {}) {
  const baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const secret = config.supabaseServiceRoleKey || '';
  const sessionSeconds = config.sessionSeconds ?? BYOK_LIMITS.maxSessionSeconds;

  function configured() {
    let url;
    try { url = new URL(baseUrl); } catch {}
    const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        typeof secret !== 'string' || !secret ||
        !Number.isInteger(sessionSeconds) || sessionSeconds < 1 || sessionSeconds > BYOK_LIMITS.maxSessionSeconds) {
      throw new StoreError(503, 'Shared voice accounting is not configured.');
    }
  }

  async function request(name, body) {
    configured();
    const headers = { apikey: secret, 'Content-Type': 'application/json' };
    // Modern secret keys are API keys, not JWTs. Legacy service-role JWTs still
    // require Authorization; never put a model/provider key in either header.
    if (!secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secret}`;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
    } catch {
      throw new StoreError(503, 'Cannot reach shared voice accounting.');
    }
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) throw upstreamError(response.status, data);
    return data;
  }

  async function reserveSession(fingerprint) {
    if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) {
      throw new StoreError(400, 'Invalid provider-key fingerprint.');
    }
    const rows = await request('cv_byok_reserve_session', {
      p_fingerprint: fingerprint,
      // Retain the RPC signature for rolling deployments. These legacy daily
      // parameters are ignored by the database; BYOK has no daily allowance.
      p_key_daily_seconds: null,
      p_global_daily_seconds: null,
      p_session_seconds: sessionSeconds,
      p_max_attempts: null,
    });
    const lease = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!UUID.test(lease?.id || '') || !Number.isInteger(lease.max_seconds) ||
        lease.max_seconds < 1 || lease.max_seconds > sessionSeconds) {
      throw new StoreError(502, 'Shared voice accounting returned an invalid reservation.');
    }
    return { id: lease.id, maxSeconds: lease.max_seconds };
  }

  async function finishSession(leaseId, elapsedSeconds) {
    if (typeof leaseId !== 'string' || !UUID.test(leaseId)) throw new StoreError(400, 'Invalid voice session ID.');
    if (typeof elapsedSeconds !== 'number' || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > 86400) {
      throw new StoreError(400, 'Invalid voice session duration.');
    }
    await request('cv_byok_finish_session', {
      p_lease_id: leaseId, p_elapsed_seconds: Math.ceil(elapsedSeconds),
    });
  }

  return { reserveSession, finishSession };
}

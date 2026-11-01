import { createHash } from 'node:crypto';
import { VOICES } from './config.mjs';
import { StoreError } from './store.mjs';

export const BYOK_PROVIDERS = Object.freeze(['gemini', 'elevenlabs', 'hume']);

// Only a provider credential is accepted here. It never becomes a dashboard,
// database, or private-device credential and is never placed in a URL/log.
export function readByokHeaders(headers) {
  const provider = headers['x-voice-provider'];
  const authorization = headers.authorization;
  if (!BYOK_PROVIDERS.includes(provider) || typeof authorization !== 'string' ||
      !/^Bearer [A-Za-z0-9_.-]{16,256}$/.test(authorization)) {
    throw new StoreError(401, 'Choose a provider and enter its API key.');
  }
  const apiKey = authorization.slice(7);
  const referenceId = headers['x-voice-reference'] || '';
  if (typeof referenceId !== 'string' ||
      (referenceId && !/^[A-Za-z0-9_.-]{1,128}$/.test(referenceId)) ||
      (provider !== 'gemini' && !referenceId)) {
    throw new StoreError(400, 'Enter the provider Agent or Config ID.');
  }
  const voice = headers['x-voice-name'] || 'Aoede';
  if (!VOICES.includes(voice)) throw new StoreError(400, 'Choose a supported Gemini voice.');
  const idleSeconds = headers['x-voice-idle-seconds'];
  const resumeHandle = headers['x-voice-resume'];
  let sessionControl;
  if (idleSeconds !== undefined || resumeHandle !== undefined) {
    if (provider !== 'gemini' || !['60', '120', '300'].includes(idleSeconds) ||
        (resumeHandle !== undefined && (typeof resumeHandle !== 'string' ||
          !/^[\x21-\x7e]{1,2048}$/.test(resumeHandle)))) {
      throw new StoreError(400, 'Invalid voice standby settings.');
    }
    sessionControl = { idleSeconds: Number(idleSeconds), ...(resumeHandle ? { resumeHandle } : {}) };
  }
  return {
    provider, apiKey, referenceId,
    fingerprint: createHash('sha256').update(`${provider}\0${apiKey}`).digest('hex'),
    context: {
      ...(sessionControl ? { sessionControl } : {}),
      providerManagedPersona: provider !== 'gemini',
      settings: {
        character_name: 'Cardputer', voice_name: voice, volume: 70,
        system_prompt: 'Be friendly and helpful. Prefer short conversational replies unless asked for more detail.',
      },
      history: [],
    },
  };
}

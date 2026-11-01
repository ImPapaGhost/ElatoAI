import test from 'node:test';
import assert from 'node:assert/strict';
import { readByokHeaders } from '../src/byok-config.mjs';

const key = 'test-only-provider-key-123456789';
const headers = { authorization: `Bearer ${key}`, 'x-voice-provider': 'gemini' };

test('BYOK fingerprints are stable, provider-specific, and omit the actual key', () => {
  const one = readByokHeaders(headers);
  const two = readByokHeaders({ ...headers, 'x-voice-provider': 'elevenlabs', 'x-voice-reference': 'agent_123' });
  assert.match(one.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(one.fingerprint, readByokHeaders(headers).fingerprint);
  assert.notEqual(one.fingerprint, two.fingerprint);
  assert.equal(one.apiKey, key);
  assert.equal(one.context.settings.voice_name, 'Aoede');
  assert.equal(one.context.history.length, 0);
});

test('BYOK rejects malformed credentials, unsupported providers, and URL-like agent IDs', () => {
  for (const invalid of [
    {}, { ...headers, authorization: 'Bearer short' },
    { ...headers, authorization: `Bearer ${key}\r\nInjected: yes` },
    { ...headers, 'x-voice-provider': 'arbitrary-service' },
    { ...headers, 'x-voice-provider': 'hume' },
    { ...headers, 'x-voice-provider': 'elevenlabs', 'x-voice-reference': 'https://attacker.test' },
    { ...headers, 'x-voice-name': 'https://attacker.test' },
  ]) assert.throws(() => readByokHeaders(invalid), error => !error.message.includes(key));
});

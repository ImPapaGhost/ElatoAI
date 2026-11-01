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

test('standby and resumption are opt-in Gemini capabilities, kept out of accounting identifiers', () => {
  const ordinary = readByokHeaders(headers);
  assert.equal(ordinary.context.sessionControl, undefined);
  for (const idle of ['60', '120', '300']) {
    const result = readByokHeaders({ ...headers, 'x-voice-idle-seconds': idle, 'x-voice-resume': 'opaque-test-session_123==' });
    assert.deepEqual(result.context.sessionControl, { idleSeconds: Number(idle), resumeHandle: 'opaque-test-session_123==' });
    assert.equal(result.fingerprint, ordinary.fingerprint);
    assert.deepEqual(result.context.history, []);
  }
  const withoutHandle = readByokHeaders({ ...headers, 'x-voice-idle-seconds': '60' });
  assert.deepEqual(withoutHandle.context.sessionControl, { idleSeconds: 60 });
});

test('resume headers reject oversized, ambiguous, unsafe, and unsupported input without echoing it', () => {
  const base = { ...headers, 'x-voice-idle-seconds': '60' };
  for (const change of [
    { 'x-voice-idle-seconds': '0' }, { 'x-voice-idle-seconds': '61' },
    { 'x-voice-idle-seconds': ['60'] }, { 'x-voice-idle-seconds': undefined, 'x-voice-resume': 'test-handle' },
    { 'x-voice-resume': ['test-handle'] }, { 'x-voice-resume': '' },
    { 'x-voice-resume': 'x'.repeat(2049) }, { 'x-voice-resume': 'test-handle\r\nInjected:yes' },
    { 'x-voice-resume': 'test handle' }, { 'x-voice-resume': 'test-handle\u007f' },
    { 'x-voice-provider': 'hume', 'x-voice-reference': 'config123' },
  ]) {
    assert.throws(() => readByokHeaders({ ...base, ...change }), error => {
      assert.equal(error.status, 400);
      assert.equal(error.message, 'Invalid voice standby settings.');
      return true;
    });
  }
  assert.equal(readByokHeaders({ ...base, 'x-voice-resume': 'x'.repeat(2048) }).context.sessionControl.resumeHandle.length, 2048);
});

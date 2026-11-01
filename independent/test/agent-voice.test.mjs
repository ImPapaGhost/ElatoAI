import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startAgentVoiceSession } from '../src/agent-voice.mjs';

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
      const first = [...this.timers.entries()].filter(([, value]) => value.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.time = first[1].at;
      this.timers.delete(first[0]);
      first[1].callback();
    }
    this.time = end;
  }
}

class DeviceSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  closes = [];
  send(value) {
    assert.equal(this.readyState, 1, 'never write to a closed device');
    this.sent.push(typeof value === 'string' ? JSON.parse(value) : Buffer.from(value));
  }
  close(code, reason) {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function wav(pcm, { rate = 48000, channels = 1, bits = 16, encoding = 1, junk = false } = {}) {
  const extra = junk ? Buffer.from('JUNK\x03\x00\x00\x00abc\x00', 'binary') : Buffer.alloc(0);
  const header = Buffer.alloc(44 + extra.length);
  header.write('RIFF', 0);
  header.writeUInt32LE(header.length + pcm.length - 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(encoding, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bits / 8, 28);
  header.writeUInt16LE(channels * bits / 8, 32);
  header.writeUInt16LE(bits, 34);
  extra.copy(header, 36);
  header.write('data', 36 + extra.length);
  header.writeUInt32LE(pcm.length, 40 + extra.length);
  return Buffer.concat([header, pcm]);
}

function setup(provider = 'elevenlabs', extra = {}) {
  const device = new DeviceSocket();
  const clock = new FakeClock();
  const providers = [];
  const fetches = [];
  const pcm = [];
  const ends = [];
  const transcripts = [];
  const codec = { resets: 0, closes: 0, flushes: 0 };
  const referenceId = provider === 'elevenlabs' ? 'agent_example_123' : '12345678-1234-4234-8234-123456789abc';
  class ProviderSocket extends EventEmitter {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    closes = [];
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      providers.push(this);
    }
    open() { this.readyState = 1; this.emit('open'); }
    message(value) { this.emit('message', typeof value === 'string' ? value : Buffer.from(JSON.stringify(value)), false); }
    send(value) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(value)); }
    close(code = 1000, reason = '') {
      this.closes.push({ code, reason });
      this.readyState = 3;
      this.emit('close', code, Buffer.from(reason));
    }
    terminate() { this.close(1006); }
  }
  const options = {
    provider, apiKey: 'provider-secret-do-not-leak', referenceId,
    deviceSocket: device, clock, maxSeconds: 180,
    context: { settings: { character_name: 'Buddy', system_prompt: 'Speak warmly.', volume: 50 }, history: [] },
    onTranscript: (entry) => transcripts.push(entry), onEnd: (entry) => ends.push(entry),
    WebSocketImpl: ProviderSocket,
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      return { ok: true, json: async () => ({ signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${referenceId}&conversation_signature=temporary-private-signature` }) };
    },
    packetizerFactory: async (send) => ({
      push(value) { pcm.push(Buffer.from(value)); send(Buffer.from(`packet:${value.length}`)); },
      flush(pad) { assert.equal(pad, true); codec.flushes += 1; send(Buffer.from('final-opus-packet')); },
      reset() { codec.resets += 1; },
      close() { codec.closes += 1; },
    }),
    ...extra,
  };
  const h = {
    provider, device, clock, providers, fetches, pcm, ends, transcripts, codec, options,
    begin() { return startAgentVoiceSession(options); },
    metadata(overrides = {}) {
      if (provider === 'elevenlabs') providers[0].message({ type: 'conversation_initiation_metadata',
        conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000', ...overrides } });
      else providers[0].message({ type: 'chat_metadata', chat_group_id: 'test-chat' });
    },
    async start(metadata = {}) {
      const pending = h.begin();
      await settle();
      assert.equal(providers.length, 1);
      providers[0].open();
      h.metadata(metadata);
      return pending;
    },
    audio(value = Buffer.alloc(5760, 8), wavOptions) {
      if (provider === 'elevenlabs') providers[0].message({ type: 'audio', audio_event: { audio_base_64: value.toString('base64'), event_id: 1 } });
      else providers[0].message({ type: 'audio_output', data: wav(value, wavOptions).toString('base64'), id: 'audio-1', index: 0 });
    },
    assistant(content = 'Hello.') {
      providers[0].message(provider === 'elevenlabs'
        ? { type: 'agent_response', agent_response_event: { agent_response: content } }
        : { type: 'assistant_message', message: { content } });
    },
    user(content = 'Hi.', interim = false) {
      providers[0].message(provider === 'elevenlabs'
        ? { type: 'user_transcript', user_transcription_event: { user_transcript: content } }
        : { type: 'user_message', message: { content }, interim });
    },
    complete() { providers[0].message({ type: provider === 'elevenlabs' ? 'agent_response_complete' : 'assistant_end' }); },
    greet() { h.audio(); h.assistant(); h.complete(); },
    controls() { return device.sent.filter((value) => !Buffer.isBuffer(value)).map((value) => value.msg || value.type); },
  };
  return h;
}

test('ElevenLabs uses its existing agent and completes only after final streamed audio', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  assert.match(h.fetches[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/convai\/conversation\/get-signed-url\?agent_id=agent_example_123$/);
  assert.equal(h.fetches[0].init.headers['xi-api-key'], h.options.apiKey);
  assert.equal(h.fetches[0].init.redirect, 'error');
  assert.equal(h.providers[0].options.followRedirects, false);
  assert.equal(h.providers[0].options.perMessageDeflate, false);
  assert.equal(h.providers[0].sent[0].type, 'conversation_initiation_client_data');
  assert.equal(h.providers[0].sent[1].type, 'contextual_update');
  h.audio();
  h.assistant('A complete transcript may arrive before all audio.');
  assert.deepEqual(h.controls(), ['auth', 'RESPONSE.CREATED']);
  h.audio(Buffer.alloc(200, 9));
  h.complete();
  assert.equal(h.device.sent.at(-2).toString(), 'final-opus-packet');
  assert.equal(h.device.sent.at(-1).msg, 'RESPONSE.COMPLETE');
  assert.equal(h.codec.resets, 1);
  assert.equal(h.codec.flushes, 1);
  assert.deepEqual(h.transcripts, [{ role: 'assistant', content: 'A complete transcript may arrive before all audio.' }]);
});

test('Hume preserves its configured clone and converts WAV48k to PCM24k without forwarding headers', async (t) => {
  const h = setup('hume');
  h.options.context.history = [{ role: 'user', content: 'My bicycle is blue.' }];
  const controller = await h.start();
  t.after(() => controller.close());
  const url = new URL(h.providers[0].url);
  assert.equal(url.origin, 'wss://api.hume.ai');
  assert.equal(url.searchParams.get('api_key'), h.options.apiKey);
  assert.equal(url.searchParams.get('config_id'), h.options.referenceId);
  assert.equal(h.fetches.length, 0);
  const settings = h.providers[0].sent[0];
  assert.deepEqual(settings.audio, { encoding: 'linear16', sample_rate: 16000, channels: 1 });
  assert.match(settings.system_prompt, /Speak warmly/);
  assert.match(settings.system_prompt, /bicycle is blue/);
  assert.equal(settings.voice_id, undefined, 'keep the voice in the Hume configuration');
  assert.match(h.providers[0].sent[1].text, /without repeating your introduction/);
  h.assistant('Hello again.');
  h.audio(Buffer.alloc(11520, 6), { junk: true });
  assert.equal(Buffer.concat(h.pcm).length, 5760);
  assert.notEqual(Buffer.concat(h.pcm).toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.device.sent.at(-1).msg, undefined, 'audio alone cannot complete a turn');
  h.complete();
  assert.equal(h.device.sent.at(-1).msg, 'RESPONSE.COMPLETE');
  assert.deepEqual(h.transcripts, [{ role: 'assistant', content: 'Hello again.' }]);
});

for (const provider of ['elevenlabs', 'hume']) {
  test(`${provider}: BYOK preserves the external agent's personality and voice`, async (t) => {
    const h = setup(provider);
    h.options.context.providerManagedPersona = true;
    h.options.context.settings.system_prompt = 'A conflicting dashboard personality must not be forwarded.';
    h.options.context.history = [{ role: 'user', content: 'Unrelated private history must not be forwarded.' }];
    const controller = await h.start();
    t.after(() => controller.close());
    if (provider === 'elevenlabs') {
      assert.deepEqual(h.providers[0].sent, [{ type: 'conversation_initiation_client_data' }]);
    } else {
      assert.deepEqual(h.providers[0].sent[0], {
        type: 'session_settings', audio: { encoding: 'linear16', sample_rate: 16000, channels: 1 },
      });
    }
    const messages = JSON.stringify(h.providers[0].sent);
    assert.doesNotMatch(messages, /conflicting dashboard|Unrelated private|system_prompt|contextual_update|voice_id|conversation_config_override/);
    h.greet();
    assert.equal(h.controls().at(-1), 'RESPONSE.COMPLETE');
  });

  test(`${provider}: microphone PCM16k is forwarded only while listening`, async (t) => {
    const h = setup(provider);
    const controller = await h.start();
    t.after(() => controller.close());
    const mic = Buffer.alloc(640, 7);
    const microphoneMessages = () => h.providers[0].sent.filter((value) => value.user_audio_chunk || value.type === 'audio_input');
    h.device.emit('message', mic, true);
    assert.equal(microphoneMessages().length, 0, 'do not forward mic during greeting');
    h.greet();
    h.device.emit('message', mic, true);
    assert.equal(microphoneMessages().length, 1);
    assert.equal(microphoneMessages()[0].user_audio_chunk || microphoneMessages()[0].data, mic.toString('base64'));
    if (provider === 'hume') {
      h.user('H', true);
      h.device.emit('message', mic, true);
      assert.equal(microphoneMessages().length, 2, 'interim transcription does not mute input');
    }
    h.user('Hello there.');
    assert.equal(h.controls().at(-1), 'AUDIO.COMMITTED');
    const before = microphoneMessages().length;
    h.device.emit('message', mic, true);
    h.audio();
    h.device.emit('message', mic, true);
    assert.equal(microphoneMessages().length, before);
    h.assistant('Hi again.');
    h.complete();
    h.device.emit('message', mic, true);
    assert.equal(microphoneMessages().length, before + 1);
    assert.deepEqual(h.transcripts.slice(-2), [
      { role: 'user', content: 'Hello there.' }, { role: 'assistant', content: 'Hi again.' },
    ]);
  });

  test(`${provider}: cleanup is idempotent and late provider events cannot write or leak errors`, async () => {
    const h = setup(provider);
    const controller = await h.start();
    h.greet();
    h.clock.advance(1201);
    await controller.close();
    await controller.close();
    const count = h.device.sent.length;
    h.providers[0].message({ type: 'error', message: h.options.apiKey });
    h.providers[0].emit('error', new Error(`${h.options.apiKey} ${h.providers[0].url}`));
    assert.equal(h.device.sent.length, count);
    assert.equal(h.ends.length, 1);
    assert.equal(h.ends[0].elapsedSeconds, 2);
    assert.equal(h.codec.closes, 1);
    assert.equal(h.providers[0].closes.length, 1);
    assert.equal(h.clock.timers.size, 0);
    assert.equal(h.device.listenerCount('message'), 0);
    assert.equal(h.providers[0].listenerCount('message'), 0);
    assert.doesNotMatch(JSON.stringify([h.device.sent, h.device.closes, h.ends]), /provider-secret|temporary-private-signature|api_key=/);
  });

  test(`${provider}: provider errors are sanitized and terminate once`, async () => {
    const h = setup(provider);
    const controller = await h.start();
    h.providers[0].message({ type: 'error', message: `${h.options.apiKey} private-provider-detail` });
    await controller.close();
    assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
    assert.equal(h.ends[0].reason, 'provider_error');
    assert.equal(h.ends.length, 1);
    assert.doesNotMatch(JSON.stringify(h.device.sent), /private-provider-detail|provider-secret/);
  });

  test(`${provider}: stalled replies fail before the Cardputer watchdog`, async () => {
    const h = setup(provider);
    const controller = await h.start();
    h.audio();
    h.clock.advance(30000);
    assert.equal(h.ends[0].reason, 'provider_response_timeout');
    assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
    await controller.close();
  });

  test(`${provider}: voice rotation waits for audio completion and a device drain grace`, async () => {
    const h = setup(provider, { maxSeconds: 25 });
    const controller = await h.start();
    h.greet();
    h.clock.advance(9000);
    h.user();
    h.audio();
    h.clock.advance(1000);
    assert.equal(h.ends.length, 0);
    h.assistant('A reply is still playing.');
    h.complete();
    h.clock.advance(999);
    assert.equal(h.ends.length, 0);
    h.clock.advance(1);
    assert.equal(h.ends[0].reason, 'session_rotation');
    assert.equal(h.controls().at(-1), 'RESPONSE.COMPLETE');
    await controller.close();
  });
}

test('ElevenLabs ping event ID zero receives a valid pong', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  h.providers[0].message({ type: 'ping', ping_event: { event_id: 0, ping_ms: 50 } });
  assert.deepEqual(h.providers[0].sent.at(-1), { type: 'pong', event_id: 0 });
});

test('ElevenLabs resampling keeps phase across arbitrary 44.1kHz chunk boundaries', async (t) => {
  const all = setup();
  const split = setup();
  const first = await all.start({ agent_output_audio_format: 'pcm_44100' });
  const second = await split.start({ agent_output_audio_format: 'pcm_44100' });
  t.after(() => first.close());
  t.after(() => second.close());
  const source = Buffer.alloc(8820);
  for (let index = 0; index < source.length / 2; index += 1) source.writeInt16LE((index * 97) % 16000 - 8000, index * 2);
  all.audio(source);
  all.complete();
  for (let offset = 0; offset < source.length; offset += 134) split.audio(source.subarray(offset, Math.min(source.length, offset + 134)));
  split.complete();
  assert.deepEqual(Buffer.concat(split.pcm), Buffer.concat(all.pcm));
  assert.equal(Buffer.concat(all.pcm).length, 4800);
});

test('16kHz agent output is resampled to 24kHz with its final sample flushed', async (t) => {
  const h = setup();
  const controller = await h.start({ agent_output_audio_format: 'pcm_16000' });
  t.after(() => controller.close());
  h.audio(Buffer.alloc(640));
  h.complete();
  assert.equal(Buffer.concat(h.pcm).length, 960);
  assert.equal(h.device.sent.at(-1).msg, 'RESPONSE.COMPLETE');
});

test('unsupported ElevenLabs metadata fails startup without sending microphone audio', async (t) => {
  for (const metadata of [
    { agent_output_audio_format: 'mp3_44100_128' },
    { user_input_audio_format: 'ulaw_8000' },
    { user_input_audio_format: 'pcm_24000' },
    { agent_output_audio_format: 'pcm_96000' },
  ]) {
    await t.test(JSON.stringify(metadata), async () => {
      const h = setup();
      const starting = h.start(metadata);
      await assert.rejects(starting, { code: 'VOICE_STARTUP_FAILED' });
      assert.equal(h.ends.length, 1);
      assert.equal(h.ends[0].reason, 'provider_audio_error');
      assert.equal(h.codec.closes, 1);
    });
  }
});

test('Hume validates WAV encoding, channel count, sample rate, and chunk boundaries', async (t) => {
  const badWavs = [
    Buffer.from('not a wave file'),
    wav(Buffer.alloc(200), { channels: 2 }),
    wav(Buffer.alloc(200), { bits: 32, encoding: 3 }),
    wav(Buffer.alloc(200), { rate: 96000 }),
    wav(Buffer.alloc(201)),
  ];
  const truncatedChunk = wav(Buffer.alloc(200));
  truncatedChunk.writeUInt32LE(0x7fffffff, 40);
  badWavs.push(truncatedChunk);
  for (const [index, invalid] of badWavs.entries()) {
    await t.test(`invalid container ${index + 1}`, async () => {
      const h = setup('hume');
      const controller = await h.start();
      h.providers[0].message({ type: 'audio_output', data: invalid.toString('base64') });
      assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
      assert.equal(h.ends[0].reason, 'provider_audio_error');
      assert.equal(h.pcm.length, 0);
      await controller.close();
    });
  }
});

test('invalid base64 and incomplete raw PCM samples fail safely', async (t) => {
  for (const invalid of ['not-valid-base64!!', 'AB==', Buffer.alloc(3).toString('base64')]) {
    await t.test(invalid, async () => {
      const h = setup();
      const controller = await h.start();
      h.providers[0].message({ type: 'audio', audio_event: { audio_base_64: invalid } });
      assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
      assert.equal(h.ends[0].reason, 'provider_audio_error');
      await controller.close();
    });
  }
});

test('a 20-second signed-URL timeout aborts fetch and ignores late authentication results', async () => {
  const pending = deferred();
  let signal;
  const h = setup('elevenlabs', { fetchImpl: async (_url, options) => { signal = options.signal; return pending.promise; } });
  const starting = h.begin();
  const rejected = assert.rejects(starting, { code: 'VOICE_STARTUP_FAILED' });
  await settle();
  h.clock.advance(20000);
  await rejected;
  assert.equal(signal.aborted, true);
  pending.resolve({ ok: true, json: async () => ({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_example_123' }) });
  await settle();
  assert.equal(h.providers.length, 0);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0].reason, 'provider_startup_timeout');
});

test('a device disconnect during codec startup closes late work exactly once', async () => {
  const pending = deferred();
  let closes = 0;
  const h = setup('hume', { packetizerFactory: () => pending.promise });
  const starting = h.begin();
  const rejected = assert.rejects(starting, { code: 'VOICE_STARTUP_FAILED' });
  h.device.close(1000, 'left');
  await rejected;
  pending.resolve({ push() {}, flush() {}, reset() {}, close() { closes += 1; } });
  await settle();
  assert.equal(closes, 1);
  assert.equal(h.providers.length, 0);
  assert.equal(h.ends.length, 1);
});

test('untrusted signed URLs cannot redirect the provider credential or create arbitrary sockets', async (t) => {
  for (const signedUrl of [
    'wss://attacker.example/v1/convai/conversation?agent_id=agent_example_123',
    'ws://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_example_123',
    'wss://api.elevenlabs.io/not-the-agent?agent_id=agent_example_123',
    'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=some-other-agent',
  ]) {
    await t.test(new URL(signedUrl).hostname + new URL(signedUrl).pathname, async () => {
      const h = setup('elevenlabs', { fetchImpl: async () => ({ ok: true, json: async () => ({ signed_url: signedUrl }) }) });
      await assert.rejects(h.begin(), { code: 'VOICE_STARTUP_FAILED' });
      assert.equal(h.providers.length, 0);
      assert.equal(h.ends[0].reason, 'provider_startup_failed');
      assert.doesNotMatch(JSON.stringify(h.device.sent), /attacker|some-other-agent|provider-secret/);
    });
  }
});

test('ElevenLabs client tool requests receive a bounded unavailable-tool answer', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  h.providers[0].message({ type: 'client_tool_call', client_tool_call: { expects_response: true, tool_call_id: 'tool-123', tool_name: 'anything' } });
  assert.deepEqual(h.providers[0].sent.at(-1), {
    type: 'client_tool_result', tool_call_id: 'tool-123',
    result: 'This handheld device does not provide client-side tools.', is_error: true,
  });
});

test('Hume supplies silent PCM while hardware input is muted, then stops all timers on close', async () => {
  const h = setup('hume');
  const controller = await h.start();
  h.clock.advance(100);
  const silence = h.providers[0].sent.at(-1);
  assert.equal(silence.type, 'audio_input');
  assert.deepEqual(Buffer.from(silence.data, 'base64'), Buffer.alloc(3200));
  await controller.close();
  const count = h.providers[0].sent.length;
  h.clock.advance(10000);
  assert.equal(h.providers[0].sent.length, count);
  assert.equal(h.clock.timers.size, 0);
});

test('oversized and excessive microphone frames terminate the voice session', async (t) => {
  for (const kind of ['oversized', 'odd', 'rate']) {
    await t.test(kind, async () => {
      const h = setup();
      const controller = await h.start();
      h.greet();
      if (kind === 'oversized') h.device.emit('message', Buffer.alloc(4098), true);
      if (kind === 'odd') h.device.emit('message', Buffer.alloc(3), true);
      if (kind === 'rate') for (let index = 0; index < 17; index += 1) h.device.emit('message', Buffer.alloc(4000), true);
      assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
      assert.equal(h.ends.length, 1);
      await controller.close();
    });
  }
});

test('device and provider output backpressure are bounded', async (t) => {
  for (const side of ['device', 'provider']) {
    await t.test(side, async () => {
      const h = setup();
      const controller = await h.start();
      if (side === 'device') { h.device.bufferedAmount = 512 * 1024 + 1; h.audio(); }
      else { h.greet(); h.providers[0].bufferedAmount = 512 * 1024 + 1; h.device.emit('message', Buffer.alloc(640), true); }
      assert.equal(h.ends[0].reason, `${side}_backpressure`);
      assert.equal(h.ends.length, 1);
      await controller.close();
    });
  }
});

test('continuous provider audio cannot exceed the hard session lease', async () => {
  const h = setup('hume', { maxSeconds: 20 });
  const controller = await h.start();
  h.audio();
  h.clock.advance(19000);
  h.audio();
  h.clock.advance(1000);
  assert.equal(h.ends[0].reason, 'session_limit');
  assert.equal(h.ends[0].elapsedSeconds, 20);
  await controller.close();
});

test('zero volume remains an intentional mute and callback failures do not break cleanup', async () => {
  const h = setup('hume', { onTranscript() { throw new Error('history unavailable'); }, onEnd() { throw new Error('accounting unavailable'); } });
  h.options.context.settings.volume = 0;
  const controller = await h.start();
  assert.equal(h.device.sent[0].volume_control, 0);
  h.greet();
  await controller.close('server_close');
  assert.equal(h.codec.closes, 1);
  assert.equal(h.clock.timers.size, 0);
});

test('oversized final transcripts cannot leave timers running after termination', async () => {
  const h = setup('hume');
  const controller = await h.start();
  h.greet();
  h.user('x'.repeat(8001));
  assert.equal(h.ends[0].reason, 'provider_transcript_limit');
  assert.equal(h.clock.timers.size, 0);
  h.device.emit('error', new Error('late device transport failure'));
  await controller.close();
});

test('duplicate Hume metadata cannot trigger a second greeting', async (t) => {
  const h = setup('hume');
  const controller = await h.start();
  t.after(() => controller.close());
  h.metadata();
  assert.equal(h.providers[0].sent.filter((message) => message.type === 'user_input').length, 1);
});

test('unsafe configuration is rejected before creating codecs or provider connections', async (t) => {
  for (const change of [
    { provider: 'unsupported' }, { apiKey: 'bad\r\nHeader: injected' },
    { referenceId: 'https://attacker.example' }, { maxSeconds: 241 }, { maxSeconds: 0 },
  ]) {
    await t.test(Object.keys(change)[0], async () => {
      const h = setup('elevenlabs', change);
      await assert.rejects(h.begin(), TypeError);
      assert.equal(h.providers.length, 0);
      assert.equal(h.fetches.length, 0);
    });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startVoiceSession } from '../src/voice.mjs';

class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  advance(ms) {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, value]) => value.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.time = target;
  }
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  closes = [];
  send(data) {
    assert.equal(this.readyState, 1, 'never send after socket close');
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : Buffer.from(data));
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

function setup(overrides = {}) {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  const ends = [];
  const transcripts = [];
  const calls = { connect: [], input: [], content: [], providerClose: 0, codecClose: 0, codecReset: 0 };
  let callbacks;
  const session = {
    sendRealtimeInput(data) { calls.input.push(data); },
    sendClientContent(data) { calls.content.push(data); },
    close() { calls.providerClose += 1; callbacks?.onclose({ reason: 'closed' }); },
  };
  const opts = {
    deviceSocket: socket,
    context: {
      settings: { character_name: 'Buddy', system_prompt: 'Be helpful.', voice_name: 'Kore', volume: 50 },
      history: [],
    },
    apiKey: 'secret-test-provider-key',
    model: 'test-live-audio-model',
    maxSeconds: 180,
    onTranscript: (entry) => transcripts.push(entry),
    onEnd: (entry) => ends.push(entry),
    clock,
    createGeminiClient: async () => ({ live: { connect: async (config) => {
      calls.connect.push(config);
      callbacks = config.callbacks;
      if (overrides.beforeConnectReturns) await overrides.beforeConnectReturns(config, session);
      return session;
    } } }),
    packetizerFactory: async (send) => ({
      push(pcm) { send(Buffer.from(`packet:${pcm.length}`)); },
      flush(pad) { assert.equal(pad, true); send(Buffer.from('tail')); },
      reset() { calls.codecReset += 1; },
      close() { calls.codecClose += 1; },
    }),
    ...overrides.options,
  };
  return {
    opts, socket, clock, ends, transcripts, calls, session,
    emit(message) { callbacks.onmessage(message); },
    error() { callbacks.onerror(new Error('secret-test-provider-key must not leak')); },
    controls() { return socket.sent.filter((entry) => !Buffer.isBuffer(entry)).map((entry) => entry.msg || entry.type); },
    async start() { return startVoiceSession(opts); },
  };
}

function audioContent(extra = {}) {
  return { serverContent: {
    modelTurn: { parts: [{ inlineData: {
      mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(5760, 8).toString('base64'),
    } }] },
    ...extra,
  } };
}

function greeting(h) {
  h.emit(audioContent({ outputTranscription: { text: 'Hello.' }, turnComplete: true }));
}

test('auth precedes streamed audio, and completion follows the final Opus packet', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  h.emit(audioContent());
  assert.deepEqual(h.controls(), ['auth', 'RESPONSE.CREATED']);
  assert.equal(h.socket.sent[2].toString(), 'packet:5760');
  h.emit({ serverContent: { outputTranscription: { text: 'Hello.' }, generationComplete: true } });
  assert.equal(h.socket.sent.length, 3, 'generationComplete alone does not clip the reply');
  h.emit({ serverContent: { turnComplete: true } });
  assert.equal(h.socket.sent.at(-2).toString(), 'tail');
  assert.equal(h.socket.sent.at(-1).msg, 'RESPONSE.COMPLETE');
  assert.deepEqual(h.transcripts, [{ role: 'assistant', content: 'Hello.' }]);
  assert.equal(h.calls.codecReset, 1);
});

test('all audio parts in an event stream in order', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  const message = audioContent();
  message.serverContent.modelTurn.parts.push({ inlineData: {
    mimeType: 'audio/pcm;rate=24000;channels=1', data: Buffer.alloc(400).toString('base64'),
  } });
  h.emit(message);
  assert.deepEqual(h.socket.sent.filter(Buffer.isBuffer).map(String), ['packet:5760', 'packet:400']);
});

test('mic is forwarded at 16kHz while listening, and transcription metadata never mutes speech', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 0, 'ignore mic during greeting');
  greeting(h);
  h.socket.emit('message', Buffer.alloc(640, 7), true);
  assert.equal(h.calls.input.length, 1);
  assert.equal(h.calls.input[0].audio.mimeType, 'audio/pcm;rate=16000');
  h.emit({ serverContent: { inputTranscription: { text: 'Hel', finished: false } } });
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 2);
  assert.ok(!h.controls().includes('AUDIO.COMMITTED'));
  h.emit({ serverContent: { inputTranscription: { text: 'lo', finished: true } } });
  assert.ok(!h.controls().includes('AUDIO.COMMITTED'));
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 3, 'a completed transcript still leaves microphone input running');
  h.emit(audioContent({ outputTranscription: { text: 'Hi again.' } }));
  assert.deepEqual(h.controls().slice(-2), ['AUDIO.COMMITTED', 'RESPONSE.CREATED']);
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 3, 'actual model audio mutes the half-duplex microphone');
  h.emit({ serverContent: { turnComplete: true } });
  assert.deepEqual(h.transcripts.slice(-2), [
    { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi again.' },
  ]);
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 4);
});

test('final transcription keeps all forty subsequent silence frames flowing to Gemini VAD', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  greeting(h);
  h.socket.emit('message', Buffer.alloc(640, 7), true);
  h.emit({ serverContent: { inputTranscription: { text: 'Hello there.', finished: true } } });
  for (let index = 0; index < 40; index += 1) {
    h.clock.advance(20);
    h.socket.emit('message', Buffer.alloc(640), true);
  }
  assert.equal(h.calls.input.length, 41);
  for (const frame of h.calls.input.slice(1)) {
    assert.equal(frame.audio.mimeType, 'audio/pcm;rate=16000');
    assert.deepEqual(Buffer.from(frame.audio.data, 'base64'), Buffer.alloc(640));
    assert.equal(frame.audioStreamEnd, undefined, 'reuse continuous input rather than adding a manual end signal');
  }
  assert.ok(!h.controls().includes('AUDIO.COMMITTED'));
  assert.equal(h.ends.length, 0);
  h.emit(audioContent({ outputTranscription: { text: 'Hi.' } }));
  assert.deepEqual(h.controls().slice(-2), ['AUDIO.COMMITTED', 'RESPONSE.CREATED']);
  h.emit({ serverContent: { turnComplete: true } });
  assert.equal(h.controls().at(-1), 'RESPONSE.COMPLETE');
});

test('the response timeout stays independent of continuously forwarded microphone silence', async () => {
  const h = setup();
  await h.start();
  greeting(h);
  h.emit({ serverContent: { inputTranscription: { text: 'Are you there?', finished: true } } });
  for (let index = 0; index < 40; index += 1) {
    h.clock.advance(20);
    h.socket.emit('message', Buffer.alloc(640), true);
  }
  h.clock.advance(29_199);
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 41, 'silence is forwarded even while the reply watchdog is armed');
  assert.equal(h.ends.length, 0);
  assert.ok(!h.controls().includes('AUDIO.COMMITTED'));
  h.clock.advance(1);
  assert.equal(h.ends[0].reason, 'provider_response_timeout');
  assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
  assert.equal(h.clock.timers.size, 0);
});

test('reconnect restores text history before a short acknowledgement request', async (t) => {
  const h = setup();
  h.opts.context.history = [{ role: 'user', content: 'My bike is blue.' }, { role: 'assistant', content: 'Nice bike.' }];
  const controller = await h.start();
  t.after(() => controller.close());
  assert.equal(h.calls.content.length, 2);
  assert.equal(h.calls.content[0].turnComplete, false);
  assert.equal(h.calls.content[0].turns[1].role, 'model');
  assert.match(h.calls.content[1].turns[0].parts[0].text, /without repeating your introduction/);
});

test('provider callbacks arriving before connect resolves still follow auth', async (t) => {
  const h = setup({ beforeConnectReturns(config) { config.callbacks.onmessage(audioContent()); } });
  const controller = await h.start();
  t.after(() => controller.close());
  assert.deepEqual(h.controls(), ['auth', 'RESPONSE.CREATED']);
});

test('device disconnect cancels a pending startup and closes a late provider connection once', async () => {
  const connect = deferred();
  const h = setup({ beforeConnectReturns: () => connect.promise });
  const startup = assert.rejects(h.start(), { code: 'VOICE_STARTUP_FAILED' });
  await settle();
  h.socket.close(1000, 'user left');
  await startup;
  const writesBeforeLateConnect = h.socket.sent.length;
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0].reason, 'device_disconnected');
  connect.resolve();
  await settle();
  assert.equal(h.calls.providerClose, 1);
  assert.equal(h.calls.codecClose, 1);
  assert.equal(h.socket.sent.length, writesBeforeLateConnect);
  assert.equal(h.clock.timers.size, 0);
});

test('20s startup timeout reports an error, releases once, and cleans up late work', async () => {
  const connect = deferred();
  const h = setup({ beforeConnectReturns: () => connect.promise });
  const startup = assert.rejects(h.start(), { code: 'VOICE_STARTUP_FAILED' });
  await settle();
  h.clock.advance(20_000);
  await startup;
  assert.equal(h.ends.length, 1);
  assert.deepEqual(h.ends[0], { elapsedSeconds: 20, reason: 'provider_startup_timeout' });
  assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
  connect.resolve();
  await settle();
  assert.equal(h.calls.providerClose, 1);
  assert.equal(h.clock.timers.size, 0);
});

test('provider error during connection cannot leak the SDK error or API key', async () => {
  const h = setup({ beforeConnectReturns(config) {
    config.callbacks.onerror(new Error('secret-test-provider-key'));
  } });
  await assert.rejects(h.start(), { message: 'Voice session could not start.' });
  assert.equal(h.ends.length, 1);
  assert.equal(h.calls.providerClose, 1);
  assert.doesNotMatch(JSON.stringify(h.socket.sent), /secret-test/);
});

test('30s stalled reply produces RESPONSE.ERROR before hardware watchdog expiry', async () => {
  const h = setup();
  await h.start();
  h.emit(audioContent());
  h.clock.advance(29_000);
  assert.equal(h.ends.length, 0);
  h.emit(audioContent());
  h.clock.advance(29_000);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1000);
  assert.equal(h.ends[0].reason, 'provider_response_timeout');
  assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
  assert.equal(h.clock.timers.size, 0);
});

test('idle session rotates before its hard deadline without putting Cardputer to sleep', async () => {
  const h = setup({ options: { maxSeconds: 60 } });
  await h.start();
  greeting(h);
  h.clock.advance(45_000);
  assert.equal(h.ends[0].reason, 'session_rotation');
  assert.ok(!h.controls().includes('SESSION.END'));
});

test('short remaining leases keep their usable time after the greeting instead of rotating in bursts', async (t) => {
  for (const maxSeconds of [10, 30]) {
    await t.test(`${maxSeconds}-second remaining lease`, async () => {
      const h = setup({ options: { maxSeconds } });
      await h.start();
      h.clock.advance(3000);
      greeting(h);
      h.clock.advance(1000);
      assert.equal(h.ends.length, 0, 'a greeting ending at 3s must not cause a 4s rotation');
      h.socket.emit('message', Buffer.alloc(640), true);
      assert.equal(h.calls.input.length, 1, 'remaining allowance is still usable for microphone input');
      h.clock.advance(maxSeconds * 1000 - 4001);
      assert.equal(h.ends.length, 0, 'keep the connection until its hard lease deadline');
      h.clock.advance(1);
      assert.deepEqual(h.ends[0], { elapsedSeconds: maxSeconds, reason: 'session_limit' });
      assert.equal(h.calls.providerClose, 1);
      assert.equal(h.clock.timers.size, 0);
      assert.ok(!h.controls().includes('SESSION.END'));
    });
  }
});

test('leases above thirty seconds retain the full fifteen-second rotation headroom', async () => {
  const h = setup({ options: { maxSeconds: 31 } });
  await h.start();
  h.clock.advance(3000);
  greeting(h);
  h.clock.advance(12_999);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1);
  assert.deepEqual(h.ends[0], { elapsedSeconds: 16, reason: 'session_rotation' });
});

test('rotation waits for an active reply to flush and complete', async () => {
  const h = setup({ options: { maxSeconds: 60 } });
  await h.start();
  greeting(h);
  h.clock.advance(44_000);
  h.emit(audioContent());
  h.clock.advance(1000);
  assert.equal(h.ends.length, 0);
  h.emit({ serverContent: { turnComplete: true } });
  assert.equal(h.ends.length, 0, 'leave time for the device to drain queued PCM');
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 0, 'new mic frames cannot start another turn during rotation');
  h.clock.advance(999);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1);
  assert.equal(h.ends[0].reason, 'session_rotation');
  assert.equal(h.controls().at(-1), 'RESPONSE.COMPLETE');
});

test('a pending recognized utterance keeps its silence stream across the rotation boundary', async () => {
  const h = setup({ options: { maxSeconds: 240 } });
  await h.start();
  greeting(h);
  h.clock.advance(224_000);
  h.emit({ serverContent: { inputTranscription: { text: 'One more question.', finished: true } } });
  h.socket.emit('message', Buffer.alloc(640, 7), true);
  h.clock.advance(1000);
  assert.equal(h.ends.length, 0, 'the rotation waits for the recognized utterance');
  for (let index = 0; index < 40; index += 1) {
    h.clock.advance(20);
    h.socket.emit('message', Buffer.alloc(640), true);
  }
  assert.equal(h.calls.input.length, 41, 'all silence still reaches automatic VAD after 225s');
  assert.ok(!h.controls().includes('AUDIO.COMMITTED'));
  h.emit(audioContent({ outputTranscription: { text: 'Here is your answer.' } }));
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 41, 'actual model audio still mutes microphone forwarding');
  h.emit({ serverContent: { turnComplete: true } });
  assert.equal(h.controls().at(-1), 'RESPONSE.COMPLETE');
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 41, 'idle rotation does not start another input turn');
  h.clock.advance(999);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1);
  assert.equal(h.ends[0].reason, 'session_rotation');
  assert.equal(h.calls.providerClose, 1);
});

test('provider rotation also leaves the just-completed audio a drain grace', async () => {
  const h = setup();
  await h.start();
  greeting(h);
  h.emit({ goAway: { timeLeft: '10s' } });
  assert.equal(h.ends.length, 0);
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 0);
  h.clock.advance(1000);
  assert.equal(h.ends[0].reason, 'provider_rotation');
});

test('zero volume is preserved as an intentional mute', async (t) => {
  const h = setup();
  h.opts.context.settings.volume = 0;
  const controller = await h.start();
  t.after(() => controller.close());
  assert.equal(h.socket.sent[0].volume_control, 0);
});

test('an incomplete codec factory fails startup before opening a provider connection', async () => {
  let partialCodecCloses = 0;
  const h = setup({ options: { packetizerFactory: async () => ({ close() { partialCodecCloses += 1; } }) } });
  await assert.rejects(h.start(), { code: 'VOICE_STARTUP_FAILED' });
  assert.equal(h.calls.connect.length, 0);
  assert.equal(partialCodecCloses, 1);
  assert.equal(h.ends.length, 1);
});

test('hard session cap ends continuously streaming audio when rotation cannot finish', async () => {
  const h = setup({ options: { maxSeconds: 60 } });
  await h.start();
  h.emit(audioContent());
  for (let i = 0; i < 3; i += 1) {
    h.clock.advance(15_000);
    h.emit(audioContent());
  }
  h.clock.advance(14_999);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1);
  assert.deepEqual(h.ends[0], { elapsedSeconds: 60, reason: 'session_limit' });
  assert.equal(h.calls.providerClose, 1);
});

test('no provider callbacks write after close, and cleanup settles exactly once', async () => {
  const h = setup();
  const controller = await h.start();
  await controller.close('owner_stop');
  const count = h.socket.sent.length;
  h.emit(audioContent({ turnComplete: true }));
  h.error();
  await controller.close('again');
  h.clock.advance(300_000);
  assert.equal(h.socket.sent.length, count);
  assert.equal(h.ends.length, 1);
  assert.equal(h.calls.providerClose, 1);
  assert.equal(h.calls.codecClose, 1);
});

test('unsupported sample rate, stereo, malformed base64, and oversized provider data fail safely', async (t) => {
  for (const change of [
    { mimeType: 'audio/pcm;rate=16000' },
    { mimeType: 'audio/pcm;rate=24000;channels=2' },
    { mimeType: 'audio/pcm;rate=24000;bits=24' },
    { data: 'not-valid-base64!!' },
    { data: Buffer.alloc(256 * 1024 + 2).toString('base64') },
  ]) {
    await t.test(JSON.stringify(change).slice(0, 80), async () => {
      const h = setup();
      await h.start();
      const message = audioContent();
      Object.assign(message.serverContent.modelTurn.parts[0].inlineData, change);
      h.emit(message);
      assert.equal(h.ends[0].reason, 'provider_audio_error');
      assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
      assert.equal(h.socket.sent.filter(Buffer.isBuffer).length, 0);
    });
  }
});

test('oversized input and full device output buffer close the session', async (t) => {
  await t.test('microphone frame bound', async () => {
    const h = setup();
    await h.start();
    greeting(h);
    h.socket.emit('message', Buffer.alloc(4098), true);
    assert.equal(h.ends[0].reason, 'invalid_device_frame');
  });
  await t.test('output backpressure', async () => {
    const h = setup();
    await h.start();
    h.socket.bufferedAmount = 512 * 1024 + 1;
    h.emit(audioContent());
    assert.equal(h.ends[0].reason, 'device_backpressure');
    assert.equal(h.socket.sent.filter(Buffer.isBuffer).length, 0);
  });
});

test('provider errors after startup are sanitized and do not retry a paid provider', async () => {
  const h = setup();
  await h.start();
  h.error();
  assert.equal(h.calls.connect.length, 1);
  assert.equal(h.ends[0].reason, 'provider_error');
  assert.equal(h.controls().at(-1), 'RESPONSE.ERROR');
  assert.doesNotMatch(JSON.stringify(h.socket.sent), /secret-test/);
});

test('session limit cannot exceed the private bridge maximum', async () => {
  const h = setup({ options: { maxSeconds: 241 } });
  await assert.rejects(h.start(), /Invalid voice session configuration/);
  assert.equal(h.calls.connect.length, 0);
});

test('legacy sessions do not enable standby, native resumption, or activity controls', async (t) => {
  const h = setup();
  const controller = await h.start();
  t.after(() => controller.close());
  assert.equal(h.calls.connect[0].config.sessionResumption, undefined);
  assert.equal(h.calls.connect[0].config.contextWindowCompression, undefined);
  greeting(h);
  h.socket.emit('message', Buffer.alloc(640), true);
  h.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'provider-checkpoint' },
    serverContent: { inputTranscription: { text: 'Hello' } } });
  h.clock.advance(61_000);
  assert.equal(h.ends.length, 0);
  assert.ok(!h.controls().includes('session'));
  assert.ok(!h.controls().includes('USER.ACTIVITY'));
  assert.ok(!h.controls().includes('SESSION.IDLE'));
});

test('standby starts after actual playback drain and silence PCM cannot reset its deadline', async () => {
  const h = setup({ options: { maxSeconds: 240 } });
  h.opts.context.sessionControl = { idleSeconds: 60 };
  await h.start();
  greeting(h);
  h.clock.advance(65_000);
  assert.equal(h.ends.length, 0, 'model completion alone does not prove playback has drained');
  h.socket.emit('message', Buffer.alloc(640), true);
  for (let index = 0; index < 11; index += 1) {
    h.clock.advance(5000);
    h.socket.emit('message', Buffer.alloc(640), true);
  }
  h.clock.advance(4999);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1);
  assert.deepEqual(h.ends, [{ elapsedSeconds: 125, reason: 'idle_standby' }]);
  assert.equal(h.controls().at(-1), 'SESSION.IDLE');
  assert.ok(!h.controls().includes('SESSION.END'));
  assert.equal(h.calls.providerClose, 1);
  assert.equal(h.calls.codecClose, 1);
  assert.equal(h.clock.timers.size, 0);
  const writes = h.socket.sent.length;
  h.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'too-late' } });
  h.clock.advance(300_000);
  assert.equal(h.socket.sent.length, writes);
  assert.equal(h.ends.length, 1);
});

test('meaningful partial transcripts reset standby and activity messages are throttled', async () => {
  const h = setup({ options: { maxSeconds: 240 } });
  h.opts.context.sessionControl = { idleSeconds: 60 };
  await h.start();
  greeting(h);
  h.socket.emit('message', Buffer.alloc(640), true);
  h.clock.advance(59_000);
  h.emit({ serverContent: { inputTranscription: { text: '   ' } } });
  assert.ok(!h.controls().includes('USER.ACTIVITY'));
  h.emit({ serverContent: { inputTranscription: { text: 'Tell me' } } });
  h.emit({ serverContent: { inputTranscription: { text: ' something' } } });
  assert.equal(h.controls().filter(value => value === 'USER.ACTIVITY').length, 1);
  h.clock.advance(1000);
  h.emit({ serverContent: { inputTranscription: { text: ' interesting.' } } });
  assert.equal(h.controls().filter(value => value === 'USER.ACTIVITY').length, 2);
  h.clock.advance(59_999);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1);
  assert.equal(h.ends[0].reason, 'idle_standby');
});

test('model output disarms standby throughout a long response and a new drain', async () => {
  const h = setup({ options: { maxSeconds: 240 } });
  h.opts.context.sessionControl = { idleSeconds: 60 };
  await h.start();
  greeting(h);
  h.socket.emit('message', Buffer.alloc(640), true);
  h.clock.advance(59_000);
  h.emit(audioContent());
  for (let index = 0; index < 3; index += 1) {
    h.clock.advance(20_000);
    h.emit(audioContent());
  }
  assert.equal(h.ends.length, 0);
  h.emit({ serverContent: { turnComplete: true } });
  h.clock.advance(61_000);
  assert.equal(h.ends.length, 0, 'a second long drain also must not idle-close');
  h.socket.emit('message', Buffer.alloc(640), true);
  h.clock.advance(44_999);
  assert.equal(h.ends.length, 0);
  // The existing hosting rotation at 225s still takes precedence over standby.
  h.clock.advance(1);
  assert.equal(h.ends[0].reason, 'session_rotation');
  assert.ok(!h.controls().includes('SESSION.IDLE'));
});

test('opt-in checkpoint updates are bounded, deduplicated, and conservatively cleared', async (t) => {
  const h = setup();
  h.opts.context.sessionControl = { idleSeconds: 60 };
  const controller = await h.start();
  t.after(() => controller.close());
  assert.deepEqual(h.calls.connect[0].config.sessionResumption, {});
  assert.deepEqual(h.calls.connect[0].config.contextWindowCompression, { slidingWindow: {} });
  const update = (resumable, newHandle) => h.emit({ sessionResumptionUpdate: { resumable, newHandle } });
  update(true, 'checkpoint-1');
  update(true, 'checkpoint-1');
  update(false, '');
  for (const invalid of ['has space', '\n', 'unicode-\u2603', 'x'.repeat(2049), null]) update(true, invalid);
  update(false, '');
  assert.deepEqual(h.socket.sent.filter(value => value.type === 'session'), [
    { type: 'session', resume_handle: 'checkpoint-1' }, { type: 'session', resume_handle: '' },
  ]);
  update(true, 'z'.repeat(2048));
  assert.equal(h.socket.sent.at(-1).resume_handle.length, 2048);
  assert.equal(h.ends.length, 0, 'invalid optional metadata does not break audio');
});

test('native resume waits for accepted setup and restores listening without a greeting', async (t) => {
  const connecting = deferred();
  const h = setup({ beforeConnectReturns: () => connecting.promise });
  h.opts.context.sessionControl = { idleSeconds: 60, resumeHandle: 'saved-checkpoint' };
  h.opts.context.history = [{ role: 'user', content: 'Earlier conversation.' }];
  const starting = h.start();
  await settle();
  assert.deepEqual(h.controls(), ['auth']);
  assert.equal(h.calls.content.length, 0);
  connecting.resolve();
  const controller = await starting;
  t.after(() => controller.close());
  assert.deepEqual(h.calls.connect[0].config.sessionResumption, { handle: 'saved-checkpoint' });
  assert.equal(h.controls().at(-1), 'SESSION.RESUMED');
  assert.equal(h.calls.content.length, 0, 'do not replay text or add a synthetic greeting');
  assert.ok(!h.controls().includes('RESPONSE.COMPLETE'));
  assert.ok(!h.controls().includes('USER.ACTIVITY'));
  h.clock.advance(31_000);
  assert.equal(h.ends.length, 0, 'resume does not arm a greeting response watchdog');
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 1);
});

test('queued resumed audio follows SESSION.RESUMED without being switched back to listening', async (t) => {
  const h = setup({ beforeConnectReturns(config) {
    config.callbacks.onmessage({ setupComplete: {} });
    config.callbacks.onmessage(audioContent());
  } });
  h.opts.context.sessionControl = { idleSeconds: 60, resumeHandle: 'saved-checkpoint' };
  const controller = await h.start();
  t.after(() => controller.close());
  assert.deepEqual(h.controls(), ['auth', 'SESSION.RESUMED', 'RESPONSE.CREATED']);
  assert.equal(h.calls.content.length, 0);
  h.socket.emit('message', Buffer.alloc(640), true);
  assert.equal(h.calls.input.length, 0);
});

test('an explicitly expired checkpoint retries fresh once and ignores obsolete callbacks', async (t) => {
  const h = setup();
  h.opts.context.sessionControl = { idleSeconds: 60, resumeHandle: 'expired-checkpoint' };
  const late = deferred();
  const attempts = [];
  let lateCloses = 0;
  let freshCloses = 0;
  const fresh = {
    sendClientContent: value => h.calls.content.push(value),
    sendRealtimeInput: value => h.calls.input.push(value),
    close() { freshCloses += 1; attempts[1].callbacks.onclose({ code: 1000 }); },
  };
  h.opts.createGeminiClient = async () => ({ live: { connect(config) {
    attempts.push(config);
    if (attempts.length === 1) {
      config.callbacks.onclose({ code: 1008, reason: 'Session resumption handle expired.' });
      return late.promise;
    }
    return Promise.resolve(fresh);
  } } });
  const controller = await h.start();
  t.after(() => controller.close());
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].config.sessionResumption, { handle: 'expired-checkpoint' });
  assert.deepEqual(attempts[1].config.sessionResumption, {});
  assert.equal(h.calls.content.length, 1, 'fresh fallback starts the ordinary greeting');
  assert.ok(!h.controls().includes('SESSION.RESUMED'));
  assert.deepEqual(h.socket.sent.find(value => value.type === 'session'), { type: 'session', resume_handle: '' });
  const count = h.socket.sent.length;
  attempts[0].callbacks.onmessage(audioContent());
  attempts[0].callbacks.onerror(new Error('expired-checkpoint secret-test-provider-key'));
  late.resolve({ close() { lateCloses += 1; } });
  await settle();
  assert.equal(lateCloses, 1);
  assert.equal(h.socket.sent.length, count);
  assert.equal(h.ends.length, 0);
  assert.doesNotMatch(JSON.stringify(h.socket.sent), /secret-test-provider-key|expired-checkpoint/);
  await controller.close();
  assert.equal(freshCloses, 1);
  assert.equal(h.ends.length, 1);
});

test('generic authentication/quota failures do not trigger a fresh resumption retry', async (t) => {
  for (const reason of ['API key invalid: secret-test-provider-key', 'Quota exhausted', 'Network unavailable']) {
    await t.test(reason.split(':')[0], async () => {
      const h = setup({ beforeConnectReturns(config) { config.callbacks.onclose({ code: 1008, reason }); } });
      h.opts.context.sessionControl = { idleSeconds: 60, resumeHandle: 'saved-checkpoint' };
      await assert.rejects(h.start(), { code: 'VOICE_STARTUP_FAILED' });
      assert.equal(h.calls.connect.length, 1);
      assert.equal(h.ends.length, 1);
      assert.equal(h.clock.timers.size, 0);
      assert.doesNotMatch(JSON.stringify(h.socket.sent), /secret-test-provider-key|Quota exhausted|Network unavailable/);
    });
  }
});

test('a fresh fallback still shares the original startup deadline and closes late work', async () => {
  const h = setup();
  h.opts.context.sessionControl = { idleSeconds: 60, resumeHandle: 'invalid-checkpoint' };
  const late = deferred();
  let attempts = 0;
  let lateCloses = 0;
  h.opts.createGeminiClient = async () => ({ live: { connect(config) {
    attempts += 1;
    if (attempts === 1) {
      config.callbacks.onclose({ reason: 'Invalid session resumption handle.' });
      return new Promise(() => {});
    }
    return late.promise;
  } } });
  const rejected = assert.rejects(h.start(), { code: 'VOICE_STARTUP_FAILED' });
  await settle();
  assert.equal(attempts, 2);
  h.clock.advance(19_999);
  assert.equal(h.ends.length, 0);
  h.clock.advance(1);
  await rejected;
  assert.equal(h.ends[0].reason, 'provider_startup_timeout');
  late.resolve({ close() { lateCloses += 1; } });
  await settle();
  assert.equal(lateCloses, 1);
  assert.equal(h.ends.length, 1);
  assert.equal(h.clock.timers.size, 0);
});

test('malformed opt-in idle settings and unsafe resume handles are rejected before connecting', async () => {
  for (const sessionControl of [null, { idleSeconds: 29 }, { idleSeconds: 301 },
    { idleSeconds: 60.5 }, { idleSeconds: 60, resumeHandle: 'has space' }]) {
    const h = setup();
    h.opts.context.sessionControl = sessionControl;
    await assert.rejects(h.start(), /Invalid voice session control/);
    assert.equal(h.calls.connect.length, 0);
    assert.equal(h.clock.timers.size, 0);
  }
});

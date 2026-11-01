import { performance } from 'node:perf_hooks';
import { createOpusPacketizer } from './opus.mjs';

const MAX_DEVICE_FRAME_BYTES = 4096;
const MAX_PROVIDER_AUDIO_BYTES = 256 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_CHARS = 8000;
const STARTUP_TIMEOUT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const realClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

async function defaultGeminiClient({ apiKey }) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey });
}

function clippedText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength).trim() : '';
}

function resumeHandle(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,2048}$/.test(value) ? value : '';
}

function rejectedResumption(event) {
  const detail = typeof event?.reason === 'string' ? event.reason
    : typeof event?.message === 'string' ? event.message : '';
  // Close codes alone also describe authentication/quota/network failures.
  // Inspect bounded diagnostics without forwarding or logging their contents.
  const text = detail.slice(0, 4096).toLowerCase();
  return /resum(?:e|ption)|session[ _-]*handle/.test(text) &&
    /invalid|expired|not[ _-]*found|no[ _-]*longer[ _-]*valid/.test(text);
}

function pcmBytes(inlineData) {
  const mime = String(inlineData.mimeType || '').toLowerCase();
  const parameters = mime.split(';').map((part) => part.trim());
  const rate = parameters.find((part) => part.startsWith('rate='));
  const channels = parameters.find((part) => part.startsWith('channels='));
  if (parameters[0] !== 'audio/pcm' || rate !== 'rate=24000' ||
      (channels && channels !== 'channels=1') ||
      parameters.slice(1).some((part) => part !== 'rate=24000' && part !== 'channels=1')) {
    throw new Error('Unsupported provider audio format.');
  }
  const encoded = inlineData.data;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_PROVIDER_AUDIO_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Invalid provider audio.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > MAX_PROVIDER_AUDIO_BYTES || bytes.byteLength % 2 !== 0) {
    throw new Error('Invalid provider audio.');
  }
  return bytes;
}

/**
 * Bridge one authorized Cardputer socket to a Gemini Live audio session.
 * Authentication, model allowlisting, and the usage lease belong to the caller.
 * Transcript callbacks receive complete turns, never provider secrets/errors.
 */
export async function startVoiceSession({
  deviceSocket, context, apiKey, model, maxSeconds,
  onTranscript = () => {}, onEnd = () => {},
  createGeminiClient = defaultGeminiClient,
  packetizerFactory = createOpusPacketizer,
  clock = realClock,
}) {
  if (!deviceSocket || !apiKey || !model || !context?.settings ||
      !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 240) {
    throw new TypeError('Invalid voice session configuration.');
  }

  const startedAt = clock.now();
  const timers = new Set();
  const settings = context.settings;
  const sessionControl = context.sessionControl;
  if (sessionControl !== undefined && (!sessionControl ||
      !Number.isInteger(sessionControl.idleSeconds) || sessionControl.idleSeconds < 30 ||
      sessionControl.idleSeconds > 300 ||
      (sessionControl.resumeHandle !== undefined && sessionControl.resumeHandle !== '' &&
        !resumeHandle(sessionControl.resumeHandle)))) {
    throw new TypeError('Invalid voice session control.');
  }
  let advertisedHandle = sessionControl ? resumeHandle(sessionControl.resumeHandle) : '';
  let closed = false;
  let providerSession;
  let providerAttempt;
  const closedProviders = new WeakSet();
  let packetizer;
  let responseTimer;
  let startupTimer;
  let idleTimer;
  let awaitingListeningFrame = false;
  let lastActivityAt = -Infinity;
  let connected = false;
  let awaitingReply = true;
  let speaking = false;
  let rotationRequested = false;
  let rotationTimer;
  let lastCompletedAt = -Infinity;
  let inputCommitted = false;
  let userTranscript = '';
  let assistantTranscript = '';
  let inputWindowStart = startedAt;
  let inputWindowBytes = 0;
  let resolveStartupStopped;
  const startupStopped = new Promise((resolve) => { resolveStartupStopped = resolve; });
  let finalization = Promise.resolve();

  function timer(callback, delay) {
    const id = clock.setTimeout(() => {
      timers.delete(id);
      if (!closed) callback();
    }, delay);
    timers.add(id);
    id?.unref?.();
    return id;
  }

  function clearTimer(id) {
    if (id === undefined) return;
    clock.clearTimeout(id);
    timers.delete(id);
  }

  function transcript(role, content) {
    const text = content.trim();
    if (!text) return;
    try {
      Promise.resolve(onTranscript({ role, content: text })).catch(() => {});
    } catch {
      // A failed history write must not break or expose provider details.
    }
  }

  function closeProvider(session) {
    if (!session || closedProviders.has(session)) return;
    closedProviders.add(session);
    try { session.close(); } catch {}
  }

  function finish(reason, code = 1000) {
    if (closed) return finalization;
    closed = true;
    connected = false;
    for (const id of timers) clock.clearTimeout(id);
    timers.clear();
    deviceSocket.off('message', onDeviceMessage);
    deviceSocket.off('close', onDeviceClose);
    deviceSocket.off('error', onDeviceError);
    try { packetizer?.close(); } catch {}
    closeProvider(providerSession);
    try {
      if (deviceSocket.readyState === 1) deviceSocket.close(code, reason);
    } catch {}
    transcript('user', userTranscript);
    transcript('assistant', assistantTranscript);
    userTranscript = '';
    assistantTranscript = '';
    resolveStartupStopped();
    const elapsedSeconds = Math.max(0, Math.ceil((clock.now() - startedAt) / 1000));
    try {
      finalization = Promise.resolve(onEnd({ elapsedSeconds, reason })).catch(() => {});
    } catch {
      finalization = Promise.resolve();
    }
    return finalization;
  }

  function send(data) {
    if (closed) return false;
    if (deviceSocket.readyState !== 1) {
      finish('device_disconnected');
      return false;
    }
    if (deviceSocket.bufferedAmount > MAX_BUFFERED_BYTES) {
      fail('device_backpressure');
      return false;
    }
    try {
      deviceSocket.send(data);
      return true;
    } catch {
      finish('device_disconnected');
      return false;
    }
  }

  function control(msg) {
    return send(JSON.stringify({ type: 'server', msg }));
  }

  function fail(reason) {
    if (closed) return;
    // The reason is an internal fixed code, never an SDK error message or key.
    if (deviceSocket.readyState === 1 && deviceSocket.bufferedAmount <= MAX_BUFFERED_BYTES) {
      try { deviceSocket.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.ERROR' })); } catch {}
    }
    finish(reason, 1011);
  }

  function armResponseTimeout() {
    clearTimer(responseTimer);
    responseTimer = timer(() => fail('provider_response_timeout'), RESPONSE_TIMEOUT_MS);
  }

  function armIdleTimeout() {
    clearTimer(idleTimer);
    if (!sessionControl || closed || !connected || speaking || awaitingReply || awaitingListeningFrame) return;
    idleTimer = timer(() => {
      if (speaking || awaitingReply) return;
      if (control('SESSION.IDLE')) finish('idle_standby');
    }, sessionControl.idleSeconds * 1000);
  }

  function inputActivity(text) {
    if (!sessionControl || typeof text !== 'string' || !text.trim()) return;
    if (clock.now() - lastActivityAt >= 1000) {
      lastActivityAt = clock.now();
      control('USER.ACTIVITY');
    }
    armIdleTimeout();
  }

  function advertiseHandle(handle) {
    if (handle === advertisedHandle) return;
    advertisedHandle = handle;
    send(JSON.stringify({ type: 'session', resume_handle: handle }));
  }

  function rotateWhenDrained(reason = 'session_rotation') {
    rotationRequested = true;
    if (closed || speaking || awaitingReply || userTranscript || rotationTimer !== undefined) return;
    // RESPONSE.COMPLETE arrives before the last PCM samples leave the device's
    // queues. A socket close clears those queues, so leave a short drain window.
    const grace = Math.max(0, 1000 - (clock.now() - lastCompletedAt));
    if (grace === 0) finish(reason);
    else rotationTimer = timer(() => finish(reason), grace);
  }

  function commitInput() {
    if (!inputCommitted) {
      inputCommitted = true;
      awaitingReply = true;
      control('AUDIO.COMMITTED');
      armResponseTimeout();
    }
  }

  function finishTurn() {
    if (!speaking) {
      fail('provider_empty_reply');
      return;
    }
    packetizer.flush(true);
    if (closed) return;
    control('RESPONSE.COMPLETE');
    clearTimer(responseTimer);
    speaking = false;
    awaitingReply = false;
    lastCompletedAt = clock.now();
    inputCommitted = false;
    transcript('user', userTranscript);
    transcript('assistant', assistantTranscript);
    userTranscript = '';
    assistantTranscript = '';
    awaitingListeningFrame = Boolean(sessionControl);
    if (rotationRequested) rotateWhenDrained();
    else armIdleTimeout();
  }

  function appendTranscript(role, text) {
    if (typeof text !== 'string') return;
    const prior = role === 'user' ? userTranscript : assistantTranscript;
    if (prior.length + text.length > MAX_TRANSCRIPT_CHARS) {
      fail('provider_transcript_limit');
      return;
    }
    if (role === 'user') userTranscript += text;
    else assistantTranscript += text;
  }

  function onProviderMessage(message) {
    if (closed) return;
    try {
      if (message?.error) {
        fail('provider_error');
        return;
      }
      if (message?.goAway) {
        rotationRequested = true;
        rotateWhenDrained('provider_rotation');
      }
      if (closed) return;
      if (sessionControl && message?.sessionResumptionUpdate) {
        const update = message.sessionResumptionUpdate;
        if (update.resumable === false) {
          // The old checkpoint may omit intervening turns. Clear the device's
          // handle until Google advertises a current, resumable checkpoint.
          advertiseHandle('');
        } else if (update.resumable === true && resumeHandle(update.newHandle)) {
          advertiseHandle(update.newHandle);
        }
      }
      const content = message?.serverContent;
      if (!content) return;
      if (content.interrupted) {
        // This device is half duplex; an unsolicited interruption must not
        // leave it indefinitely waiting for the remainder of an audio turn.
        fail('provider_interrupted');
        return;
      }
      if (content.inputTranscription) {
        appendTranscript('user', content.inputTranscription.text);
        inputActivity(content.inputTranscription.text);
        // As in ElatoAI's Gemini adapter, transcription is metadata: keep
        // forwarding microphone PCM (including silence) for automatic VAD.
        // Only actual model audio below changes the device out of listening.
        if (content.inputTranscription.finished && userTranscript) armResponseTimeout();
      }
      if (content.outputTranscription) {
        appendTranscript('assistant', content.outputTranscription.text);
      }
      const parts = content.modelTurn?.parts || [];
      if (!Array.isArray(parts) || parts.length > 64) throw new Error('Invalid provider parts.');
      for (const part of parts) {
        if (closed) return;
        if (!part.inlineData) continue;
        const audio = pcmBytes(part.inlineData);
        if (audio.length === 0) continue;
        if (!speaking) {
          clearTimer(idleTimer);
          if (userTranscript) commitInput();
          packetizer.reset();
          speaking = true;
          awaitingReply = true;
          if (!control('RESPONSE.CREATED')) return;
        }
        armResponseTimeout();
        // Callbacks execute synchronously on one JS thread. Encoding each part
        // here preserves frame order without an unbounded asynchronous queue.
        packetizer.push(audio);
      }
      if (!closed && content.turnComplete) finishTurn();
    } catch {
      fail('provider_audio_error');
    }
  }

  function onDeviceMessage(data, isBinary) {
    if (closed) return;
    try {
      const binary = isBinary === true || (isBinary === undefined && typeof data !== 'string');
      const bytes = Buffer.isBuffer(data) ? data
        : data instanceof ArrayBuffer ? Buffer.from(data)
          : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : typeof data === 'string' ? Buffer.from(data) : null;
      if (!bytes || bytes.length > MAX_DEVICE_FRAME_BYTES || (binary && bytes.length % 2 !== 0)) {
        fail('invalid_device_frame');
        return;
      }
      if (!binary) {
        const instruction = JSON.parse(bytes.toString('utf8'));
        if (instruction?.type === 'instruction' && instruction.msg === 'END_SESSION') {
          finish('device_end');
        }
        return;
      }
      if (!connected || speaking || awaitingReply ||
          (rotationRequested && !userTranscript) || bytes.length === 0) return;
      const now = clock.now();
      if (now - inputWindowStart >= 1000) {
        inputWindowStart = now;
        inputWindowBytes = 0;
      }
      inputWindowBytes += bytes.length;
      if (inputWindowBytes > 64_000) {
        fail('device_audio_rate_limit');
        return;
      }
      if (sessionControl && awaitingListeningFrame) {
        // Firmware sends mic PCM only after playback is fully drained. Start
        // idle time at that first frame; later silence frames never reset it.
        awaitingListeningFrame = false;
        armIdleTimeout();
      }
      providerSession.sendRealtimeInput({
        audio: { data: bytes.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch {
      fail('device_audio_error');
    }
  }

  function onDeviceClose() { finish('device_disconnected'); }
  function onDeviceError() { finish('device_error'); }
  deviceSocket.on('message', onDeviceMessage);
  deviceSocket.on('close', onDeviceClose);
  deviceSocket.on('error', onDeviceError);

  const controller = { close: (reason = 'server_close') => finish(reason) };
  timer(() => finish('session_limit'), maxSeconds * 1000);
  // Full sessions leave headroom for the host deadline. A short, partial quota
  // lease needs its remaining time instead: rotating after a one-second timer
  // would otherwise spend the tail allowance on repeated greetings/reconnects.
  if (maxSeconds > 30) {
    timer(() => {
      rotationRequested = true;
      rotateWhenDrained();
    }, maxSeconds * 1000 - 15_000);
  }
  startupTimer = timer(() => fail('provider_startup_timeout'), STARTUP_TIMEOUT_MS);

  const startup = (async () => {
    const codec = await packetizerFactory((packet) => send(packet));
    if (!codec || ['push', 'flush', 'reset', 'close'].some((method) => typeof codec[method] !== 'function')) {
      try { codec?.close?.(); } catch {}
      throw new Error('Voice codec is unavailable.');
    }
    if (closed) { codec.close(); return; }
    packetizer = codec;
    const client = await createGeminiClient({ apiKey });
    if (closed) return;
    const configuredVolume = Number(settings.volume);
    const volume = Number.isFinite(configuredVolume)
      ? Math.min(100, Math.max(0, configuredVolume)) : 50;
    if (!send(JSON.stringify({
      type: 'auth', volume_control: volume, pitch_factor: 1,
      is_ota: false, is_reset: false,
    }))) return;

    const baseConfig = {
        responseModalities: ['AUDIO'],
        systemInstruction: [
          clippedText(settings.system_prompt, 8000),
          `Your name is ${clippedText(settings.character_name, 80) || 'Companion'}.`,
          'You are speaking through a handheld voice device. Keep replies conversational and brief, usually no more than three short sentences.',
        ].filter(Boolean).join('\n'),
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: clippedText(settings.voice_name, 80) || 'Kore' } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: false, silenceDurationMs: 700 },
          activityHandling: 'NO_INTERRUPTION',
        },
      ...(sessionControl ? {
        sessionResumption: {}, contextWindowCompression: { slidingWindow: {} },
      } : {}),
    };
    let requestedHandle = advertisedHandle;
    let session;
    for (let attemptNumber = 0; attemptNumber < 2 && !closed; attemptNumber += 1) {
      const attempt = { handle: requestedHandle, accepted: false, progress: false, rejected: false, announced: false };
      providerAttempt = attempt;
      let rejectAttempt;
      const failedAttempt = new Promise((_, reject) => { rejectAttempt = reject; });
      const current = () => !closed && providerAttempt === attempt;
      const announceResumed = () => {
        if (!current() || !attempt.handle || attempt.announced || speaking) return;
        attempt.announced = true;
        awaitingReply = false;
        control('SESSION.RESUMED');
      };
      const canRejectResume = (event) => attempt.handle && !attempt.accepted && !attempt.progress &&
        rejectedResumption(event);
      const config = {
        ...baseConfig,
        ...(sessionControl ? { sessionResumption: requestedHandle ? { handle: requestedHandle } : {} } : {}),
      };
      const connection = Promise.resolve().then(() => client.live.connect({
        model, config,
        callbacks: {
          onmessage(message) {
            if (!current()) return;
            if (message?.setupComplete) {
              attempt.accepted = true;
              announceResumed();
            }
            if (message?.error && canRejectResume(message.error)) {
              attempt.rejected = true;
              return; // Wait for this rejected socket to close before retrying.
            }
            if (message?.serverContent) attempt.progress = true;
            onProviderMessage(message);
          },
          onerror(event) {
            if (!current()) return;
            if (canRejectResume(event)) attempt.rejected = true;
            else fail('provider_error');
          },
          onclose(event) {
            if (!current()) return;
            if (!attempt.accepted && !attempt.progress && (attempt.rejected || canRejectResume(event))) {
              const error = new Error('Session checkpoint was rejected.');
              error.code = 'RESUME_REJECTED';
              rejectAttempt(error);
            } else fail('provider_closed');
          },
        },
      }));
      // SDK 2.32 does not reject connect() when its setup socket closes. Also
      // close an obsolete connection if its promise resolves after cancellation.
      connection.then((late) => {
        if (!current()) closeProvider(late);
      }, () => {});
      try {
        session = await Promise.race([connection, failedAttempt, startupStopped.then(() => null)]);
      } catch (error) {
        if (error?.code !== 'RESUME_REJECTED' || !requestedHandle || attemptNumber !== 0 || closed) throw error;
        providerAttempt = undefined;
        advertiseHandle('');
        requestedHandle = '';
        continue;
      }
      if (closed) { closeProvider(session); return; }
      attempt.accepted = true; // SDK resolves only after setupComplete.
      if (requestedHandle) announceResumed();
      break;
    }
    if (closed) { closeProvider(session); return; }
    providerSession = session;
    connected = true;
    clearTimer(startupTimer);
    if (requestedHandle) {
      if (!speaking) awaitingReply = false;
      awaitingListeningFrame = true;
      armIdleTimeout();
      return; // Native context restoration needs no greeting or text replay.
    }
    const history = (Array.isArray(context.history) ? context.history : [])
      .filter((item) => (item?.role === 'user' || item?.role === 'assistant') && typeof item.content === 'string')
      .slice(-20)
      .map((item) => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: clippedText(item.content, 2000) }],
      }));
    if (history.length) session.sendClientContent({ turns: history, turnComplete: false });
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: history.length
        ? 'The device connection has resumed. Remember the conversation above. Say a brief acknowledgement that you are ready, without repeating your introduction, then wait for me to speak.'
        : 'Greet me in one short friendly sentence, then wait for me to speak.' }] }],
      turnComplete: true,
    });
    if (!closed) armResponseTimeout();
  })();

  const outcome = await Promise.race([
    startup.then(() => 'ready', () => 'failed'),
    startupStopped.then(() => 'stopped'),
  ]);
  if (outcome === 'failed') fail('provider_startup_failed');
  if (closed) {
    await finalization;
    const error = new Error('Voice session could not start.');
    error.code = 'VOICE_STARTUP_FAILED';
    throw error;
  }
  return controller;
}

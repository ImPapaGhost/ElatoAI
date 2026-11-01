// Adapted from ElatoAI's server/deno/models/elevenlabs.ts and hume.ts (MIT).
// Provider-owned Agent/Config IDs retain their existing cloned voice settings.
// https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket
// https://dev.hume.ai/voice/reference/speech-to-speech-evi/chat
import { performance } from 'node:perf_hooks';
import { WebSocket as DefaultWebSocket } from 'ws';
import { createOpusPacketizer } from './opus.mjs';

const MAX_DEVICE_BYTES = 4096;
const MAX_PROVIDER_MESSAGE_BYTES = 3 * 1024 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_CHARS = 8000;
const STARTUP_TIMEOUT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const OUTPUT_RATE = 24_000;
const PCM_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);
const ELEVEN_HOSTS = new Set([
  'api.elevenlabs.io', 'api.eu.residency.elevenlabs.io',
  'api.in.residency.elevenlabs.io', 'api.sg.residency.elevenlabs.io',
]);
const realClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (id) => clearTimeout(id),
};
const ignoreLateError = () => {};

function text(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit).trim() : '';
}

function bytes(value, limit) {
  let result;
  if (Buffer.isBuffer(value)) result = value;
  else if (typeof value === 'string') {
    if (Buffer.byteLength(value) > limit) throw new Error('Frame too large.');
    result = Buffer.from(value);
  } else if (value instanceof ArrayBuffer) result = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) result = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else throw new Error('Invalid frame.');
  if (result.length > limit) throw new Error('Frame too large.');
  return result;
}

function decodeAudio(encoded) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Invalid audio.');
  }
  const result = Buffer.from(encoded, 'base64');
  if (result.length > MAX_AUDIO_BYTES || result.toString('base64') !== encoded) {
    throw new Error('Invalid audio.');
  }
  return result;
}

function rawPcmFormat(value) {
  const match = /^pcm_(\d+)$/.exec(String(value));
  const rate = match ? Number(match[1]) : 0;
  if (!PCM_RATES.has(rate)) throw new Error('Unsupported PCM format.');
  return rate;
}

// Hume's audio_output is a complete WAV container, not headerless PCM.
// Parse RIFF chunks rather than assuming data always starts at byte 44.
function wavPcm(encoded) {
  const wav = decodeAudio(encoded);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV.');
  const limit = wav.readUInt32LE(4) + 8;
  if (limit < 44 || limit > wav.length) throw new Error('Invalid WAV length.');
  let format;
  let pcm;
  let offset = 12;
  let chunks = 0;
  while (offset + 8 <= limit) {
    if (++chunks > 128) throw new Error('Too many WAV chunks.');
    const name = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (length > limit - start) throw new Error('Invalid WAV chunk.');
    if (name === 'fmt ') {
      if (format || length < 16) throw new Error('Invalid WAV format.');
      const encoding = wav.readUInt16LE(start);
      const channels = wav.readUInt16LE(start + 2);
      const rate = wav.readUInt32LE(start + 4);
      const byteRate = wav.readUInt32LE(start + 8);
      const alignment = wav.readUInt16LE(start + 12);
      const bits = wav.readUInt16LE(start + 14);
      if (encoding !== 1 || channels !== 1 || bits !== 16 || !PCM_RATES.has(rate) ||
          alignment !== 2 || byteRate !== rate * 2) throw new Error('Unsupported WAV format.');
      format = { rate };
    } else if (name === 'data') {
      if (pcm || length % 2 !== 0) throw new Error('Invalid WAV data.');
      pcm = wav.subarray(start, start + length);
    }
    offset = start + length + (length & 1);
  }
  if (!format || !pcm || pcm.length === 0 || offset !== limit) throw new Error('Incomplete WAV.');
  return { pcm, rate: format.rate };
}

// Preserve interpolation phase across provider chunks. Resetting at every WAV
// chunk changes sample counts at 44.1 kHz and creates audible discontinuities.
class PcmResampler {
  constructor(sourceRate, targetRate = OUTPUT_RATE) {
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
    this.samples = 0;
    this.nextNumerator = 0;
    this.previous = 0;
  }

  push(pcm) {
    if (pcm.length % 2 !== 0) throw new Error('Incomplete PCM sample.');
    if (this.sourceRate === this.targetRate) {
      this.samples += pcm.length / 2;
      return pcm;
    }
    const count = pcm.length / 2;
    const output = Buffer.alloc((Math.ceil(count * this.targetRate / this.sourceRate) + 2) * 2);
    let written = 0;
    for (let index = 0; index < count; index += 1) {
      const current = pcm.readInt16LE(index * 2);
      const absolute = this.samples++;
      while (this.nextNumerator <= absolute * this.targetRate) {
        const fraction = absolute === 0 ? 1 :
          (this.nextNumerator - (absolute - 1) * this.targetRate) / this.targetRate;
        const sample = this.previous + (current - this.previous) * fraction;
        output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), written);
        written += 2;
        this.nextNumerator += this.sourceRate;
      }
      this.previous = current;
    }
    return output.subarray(0, written);
  }

  flush() {
    if (this.sourceRate === this.targetRate || this.samples === 0) return Buffer.alloc(0);
    const pending = Math.max(0, Math.ceil((this.samples * this.targetRate - this.nextNumerator) / this.sourceRate));
    const output = Buffer.alloc(pending * 2);
    for (let index = 0; index < pending; index += 1) output.writeInt16LE(this.previous, index * 2);
    this.nextNumerator += pending * this.sourceRate;
    return output;
  }
}

function characterContext(context) {
  // BYOK Agent/Config IDs already own their character prompt and clone. Only
  // advanced/private callers that explicitly supply their own context add one.
  if (context.providerManagedPersona === true) return '';
  const settings = context.settings;
  const history = (Array.isArray(context.history) ? context.history : [])
    .filter((item) => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string')
    .slice(-10).map((item) => `${item.role}: ${text(item.content, 1000)}`).join('\n');
  return [
    text(settings.system_prompt, 8000),
    settings.character_name ? `The user calls this character ${text(settings.character_name, 80)}.` : '',
    'You are speaking through a handheld device. Keep spoken replies conversational and brief, usually one to three short sentences.',
    history ? `Previous conversation for continuity:\n${history}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Reuse ElatoAI's configured ElevenLabs Agent / Hume EVI integration. This does
 * not create clones or save provider keys; the caller authenticates the device
 * and explicitly supplies its owner's ephemeral BYOK credential and lease.
 * ElevenLabs must enable the agent_response_complete client event; a text
 * agent_response is deliberately NOT treated as the end of streamed speech.
 */
export async function startAgentVoiceSession({
  provider, apiKey, referenceId, deviceSocket, context, maxSeconds,
  onTranscript = () => {}, onEnd = () => {},
  fetchImpl = fetch, WebSocketImpl = DefaultWebSocket,
  packetizerFactory = createOpusPacketizer, clock = realClock,
}) {
  if (!['elevenlabs', 'hume'].includes(provider) || !deviceSocket || !context?.settings ||
      typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(apiKey) ||
      typeof referenceId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(referenceId) ||
      !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 240) {
    throw new TypeError('Invalid agent voice configuration.');
  }
  const startedAt = clock.now();
  const timers = new Set();
  const fetchAbort = new AbortController();
  const prompt = characterContext(context);
  let closed = false;
  let connected = false;
  let providerSocket;
  let providerCloseAttempted = false;
  let providerOpened = false;
  let packetizer;
  let resampler;
  let outputRate;
  let speaking = false;
  let awaitingReply = true;
  let inputCommitted = false;
  let userTranscript = '';
  let assistantTranscript = '';
  let responseTimer;
  let startupTimer;
  let rotationTimer;
  let rotationRequested = false;
  let lastCompletedAt = -Infinity;
  let inputWindowStart = startedAt;
  let inputWindowBytes = 0;
  let lastMicAt = startedAt;
  let finalization = Promise.resolve();
  let resolveStopped;
  let resolveReady;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function timer(callback, delay) {
    if (closed) return undefined;
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
    if (!content.trim()) return;
    try { Promise.resolve(onTranscript({ role, content: content.trim() })).catch(() => {}); } catch {}
  }

  function finish(reason, code = 1000) {
    if (closed) return finalization;
    closed = true;
    connected = false;
    fetchAbort.abort();
    for (const id of timers) clock.clearTimeout(id);
    timers.clear();
    deviceSocket.on('error', ignoreLateError);
    deviceSocket.off('message', onDeviceMessage);
    deviceSocket.off('close', onDeviceClose);
    deviceSocket.off('error', onDeviceError);
    try { packetizer?.close(); } catch {}
    if (providerSocket) {
      providerSocket.on('error', ignoreLateError);
      providerSocket.off('open', onProviderOpen);
      providerSocket.off('message', onProviderMessage);
      providerSocket.off('close', onProviderClose);
      providerSocket.off('error', onProviderError);
      if (!providerCloseAttempted && providerSocket.readyState < 2) {
        providerCloseAttempted = true;
        try {
          if (providerSocket.readyState === 0 && typeof providerSocket.terminate === 'function') providerSocket.terminate();
          else providerSocket.close(1000, 'voice_session_ended');
        } catch {}
      }
    }
    try { if (deviceSocket.readyState === 1) deviceSocket.close(code, reason); } catch {}
    transcript('user', userTranscript);
    transcript('assistant', assistantTranscript);
    userTranscript = '';
    assistantTranscript = '';
    resolveStopped();
    const elapsedSeconds = Math.max(0, Math.ceil((clock.now() - startedAt) / 1000));
    try { finalization = Promise.resolve(onEnd({ elapsedSeconds, reason })).catch(() => {}); }
    catch { finalization = Promise.resolve(); }
    return finalization;
  }

  function fail(reason) {
    if (closed) return;
    if (deviceSocket.readyState === 1 && deviceSocket.bufferedAmount <= MAX_BUFFERED_BYTES) {
      try { deviceSocket.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.ERROR' })); } catch {}
    }
    finish(reason, 1011);
  }

  function send(data) {
    if (closed) return false;
    if (deviceSocket.readyState !== 1) { finish('device_disconnected'); return false; }
    if (deviceSocket.bufferedAmount > MAX_BUFFERED_BYTES) { fail('device_backpressure'); return false; }
    try { deviceSocket.send(data); return true; }
    catch { finish('device_disconnected'); return false; }
  }

  function control(msg) { return send(JSON.stringify({ type: 'server', msg })); }

  function sendProvider(message) {
    if (closed) return false;
    if (providerSocket?.readyState !== 1) { fail('provider_disconnected'); return false; }
    if (providerSocket.bufferedAmount > MAX_BUFFERED_BYTES) { fail('provider_backpressure'); return false; }
    try { providerSocket.send(JSON.stringify(message)); return true; }
    catch { fail('provider_send_error'); return false; }
  }

  function armResponseTimeout() {
    clearTimer(responseTimer);
    responseTimer = timer(() => fail('provider_response_timeout'), RESPONSE_TIMEOUT_MS);
  }

  function rotateWhenDrained(reason = 'session_rotation') {
    rotationRequested = true;
    if (closed || speaking || awaitingReply || userTranscript || rotationTimer !== undefined) return;
    const grace = Math.max(0, 1000 - (clock.now() - lastCompletedAt));
    if (grace === 0) finish(reason);
    else rotationTimer = timer(() => finish(reason), grace);
  }

  function commitInput() {
    if (closed || inputCommitted) return;
    inputCommitted = true;
    awaitingReply = true;
    control('AUDIO.COMMITTED');
    armResponseTimeout();
  }

  function appendTranscript(role, content) {
    if (typeof content !== 'string' || !content.trim()) return;
    const prior = role === 'user' ? userTranscript : assistantTranscript;
    const joined = prior ? `${prior}\n${content.trim()}` : content.trim();
    if (joined.length > MAX_TRANSCRIPT_CHARS) { fail('provider_transcript_limit'); return; }
    if (role === 'user') userTranscript = joined;
    else assistantTranscript = joined;
  }

  function audio(pcm, rate) {
    if (closed || pcm.length === 0) return;
    if (pcm.length % 2 !== 0 || !PCM_RATES.has(rate)) throw new Error('Invalid PCM.');
    if (!speaking) {
      if (userTranscript) commitInput();
      if (closed) return;
      packetizer.reset();
      resampler = new PcmResampler(rate);
      outputRate = rate;
      speaking = true;
      awaitingReply = true;
      if (!control('RESPONSE.CREATED')) return;
    }
    if (rate !== outputRate) throw new Error('Audio rate changed during response.');
    armResponseTimeout();
    const output = resampler.push(pcm);
    if (output.length) packetizer.push(output);
  }

  function finishTurn() {
    if (closed) return;
    if (!speaking) { fail('provider_empty_reply'); return; }
    const tail = resampler.flush();
    if (tail.length) packetizer.push(tail);
    packetizer.flush(true);
    if (closed) return;
    if (!control('RESPONSE.COMPLETE')) return;
    clearTimer(responseTimer);
    speaking = false;
    awaitingReply = false;
    inputCommitted = false;
    resampler = undefined;
    lastCompletedAt = clock.now();
    transcript('user', userTranscript);
    transcript('assistant', assistantTranscript);
    userTranscript = '';
    assistantTranscript = '';
    if (rotationRequested) rotateWhenDrained();
  }

  function markReady() {
    if (connected || closed) return;
    connected = true;
    clearTimer(startupTimer);
    armResponseTimeout();
    resolveReady();
  }

  function onElevenMessage(message) {
    if (message.type === 'conversation_initiation_metadata') {
      if (connected) throw new Error('Duplicate provider metadata.');
      const metadata = message.conversation_initiation_metadata_event;
      if (rawPcmFormat(metadata?.user_input_audio_format) !== 16000) throw new Error('Input must be PCM16 at 16 kHz.');
      outputRate = rawPcmFormat(metadata?.agent_output_audio_format);
      markReady();
      // The configured agent supplies its first_message and selected clone.
      // Context updates do not interrupt that initial greeting.
      if (prompt) sendProvider({ type: 'contextual_update', text: prompt });
    } else if (message.type === 'ping') {
      const id = message.ping_event?.event_id;
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid ping.');
      sendProvider({ type: 'pong', event_id: id });
    } else if (message.type === 'audio') {
      if (!connected || !outputRate) throw new Error('Audio before metadata.');
      audio(decodeAudio(message.audio_event?.audio_base_64), outputRate);
    } else if (message.type === 'user_transcript') {
      if (!connected) throw new Error('Transcript before metadata.');
      appendTranscript('user', message.user_transcription_event?.user_transcript);
      commitInput();
    } else if (message.type === 'agent_response') {
      if (!connected) throw new Error('Transcript before metadata.');
      appendTranscript('assistant', message.agent_response_event?.agent_response);
      // This text event can precede later audio chunks. Only the explicitly
      // enabled agent_response_complete event ends the spoken response.
    } else if (message.type === 'agent_response_complete') {
      finishTurn();
    } else if (message.type === 'interruption' || message.type === 'agent_response_correction') {
      fail('provider_interrupted');
    } else if (['error', 'client_error', 'guardrail_triggered'].includes(message.type)) {
      fail('provider_error');
    } else if (message.type === 'queue_status') {
      if (message.queue_status_event?.status !== 'admitted') fail('provider_not_available');
    } else if (message.type === 'conversation_end') {
      if (speaking) finishTurn();
      if (!closed) rotateWhenDrained('provider_ended');
    } else if (message.type === 'client_tool_call') {
      // This bridge has no browser/device tools to execute; answer explicitly
      // instead of leaving an agent's pending tool call hanging indefinitely.
      const tool = message.client_tool_call;
      if (tool?.expects_response && typeof tool.tool_call_id === 'string' &&
          /^[A-Za-z0-9_-]{1,160}$/.test(tool.tool_call_id)) {
        sendProvider({ type: 'client_tool_result', tool_call_id: tool.tool_call_id,
          result: 'This handheld device does not provide client-side tools.', is_error: true });
      } else if (tool?.expects_response) {
        fail('provider_invalid_tool');
      }
    }
  }

  function onHumeMessage(message) {
    if (message.type === 'chat_metadata') {
      if (connected) return;
      markReady();
      sendProvider({ type: 'user_input', text: context.history?.length
        ? 'The device reconnected. Briefly acknowledge that you are ready, without repeating your introduction, then wait for me to speak.'
        : 'Greet me in one short friendly sentence, then wait for me to speak.' });
    } else if (message.type === 'audio_output') {
      if (!connected) throw new Error('Audio before metadata.');
      const { pcm, rate } = wavPcm(message.data);
      audio(pcm, rate);
    } else if (message.type === 'user_message') {
      if (!connected) throw new Error('Transcript before metadata.');
      if (message.interim === true) return;
      appendTranscript('user', message.message?.content);
      commitInput();
    } else if (message.type === 'assistant_message') {
      if (!connected) throw new Error('Transcript before metadata.');
      appendTranscript('assistant', message.message?.content);
    } else if (message.type === 'assistant_end') {
      finishTurn();
    } else if (message.type === 'user_interruption') {
      fail('provider_interrupted');
    } else if (message.type === 'error') {
      fail('provider_error');
    }
  }

  function onProviderMessage(data) {
    if (closed) return;
    try {
      const message = JSON.parse(bytes(data, MAX_PROVIDER_MESSAGE_BYTES).toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
        throw new Error('Invalid provider message.');
      }
      if (provider === 'elevenlabs') onElevenMessage(message);
      else onHumeMessage(message);
    } catch { fail('provider_audio_error'); }
  }

  function onProviderOpen() {
    if (closed || providerOpened) return;
    providerOpened = true;
    if (provider === 'elevenlabs') {
      sendProvider({ type: 'conversation_initiation_client_data' });
    } else {
      sendProvider({ type: 'session_settings',
        audio: { encoding: 'linear16', sample_rate: 16000, channels: 1 },
        ...(prompt ? { system_prompt: prompt } : {}) });
    }
  }

  function onProviderClose(code) {
    if (closed) return;
    if (code === 1000 && connected && !awaitingReply && !speaking) {
      rotateWhenDrained('provider_ended');
    } else fail('provider_closed');
  }

  function onProviderError() { fail('provider_error'); }

  function onDeviceMessage(data, isBinary) {
    if (closed) return;
    try {
      const binary = isBinary === true || (isBinary === undefined && typeof data !== 'string');
      const input = bytes(data, MAX_DEVICE_BYTES);
      if (binary && input.length % 2 !== 0) throw new Error('Incomplete microphone sample.');
      if (!binary) {
        const instruction = JSON.parse(input.toString('utf8'));
        if (instruction?.type === 'instruction' && instruction.msg === 'END_SESSION') finish('device_end');
        return;
      }
      if (!connected || speaking || awaitingReply || rotationRequested || input.length === 0) return;
      const now = clock.now();
      if (now - inputWindowStart >= 1000) { inputWindowStart = now; inputWindowBytes = 0; }
      inputWindowBytes += input.length;
      if (inputWindowBytes > 64000) { fail('device_audio_rate_limit'); return; }
      lastMicAt = now;
      if (provider === 'elevenlabs') sendProvider({ user_audio_chunk: input.toString('base64') });
      else sendProvider({ type: 'audio_input', data: input.toString('base64') });
    } catch { fail('device_audio_error'); }
  }

  function humeSilence() {
    // Hume expects a continuous PCM stream even while the hardware microphone
    // is muted for speaker playback. Silence distinguishes mute from a gap.
    if (connected && (speaking || awaitingReply || clock.now() - lastMicAt >= 150)) {
      sendProvider({ type: 'audio_input', data: Buffer.alloc(3200).toString('base64') });
    }
    if (!closed) timer(humeSilence, 100);
  }

  function onDeviceClose() { finish('device_disconnected'); }
  function onDeviceError() { finish('device_error'); }
  deviceSocket.on('message', onDeviceMessage);
  deviceSocket.on('close', onDeviceClose);
  deviceSocket.on('error', onDeviceError);
  timer(() => finish('session_limit'), maxSeconds * 1000);
  timer(() => rotateWhenDrained(), Math.max(1000, maxSeconds * 1000 - 15000));
  startupTimer = timer(() => fail('provider_startup_timeout'), STARTUP_TIMEOUT_MS);

  const startup = (async () => {
    const codec = await packetizerFactory((packet) => send(packet));
    if (!codec || ['push', 'flush', 'reset', 'close'].some((method) => typeof codec[method] !== 'function')) {
      try { codec?.close?.(); } catch {}
      throw new Error('Voice codec unavailable.');
    }
    if (closed) { codec.close(); return; }
    packetizer = codec;
    const configuredVolume = Number(context.settings.volume);
    const volume = Number.isFinite(configuredVolume) ? Math.max(0, Math.min(100, configuredVolume)) : 50;
    if (!send(JSON.stringify({ type: 'auth', volume_control: volume, pitch_factor: 1, is_ota: false, is_reset: false }))) return;
    let url;
    if (provider === 'elevenlabs') {
      const response = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(referenceId)}`, {
        headers: { 'xi-api-key': apiKey.trim(), Accept: 'application/json' },
        signal: fetchAbort.signal, redirect: 'error',
      });
      if (closed) return;
      if (!response?.ok) throw new Error('Agent authentication failed.');
      const body = await response.json();
      if (closed) return;
      if (typeof body?.signed_url !== 'string' || body.signed_url.length > 4096) throw new Error('Invalid agent URL.');
      url = new URL(body.signed_url);
      if (url.protocol !== 'wss:' || !ELEVEN_HOSTS.has(url.hostname) ||
          url.username || url.password || (url.port && url.port !== '443') ||
          url.pathname !== '/v1/convai/conversation' || url.searchParams.get('agent_id') !== referenceId) {
        throw new Error('Invalid agent URL.');
      }
    } else {
      url = new URL('wss://api.hume.ai/v0/evi/chat');
      url.searchParams.set('config_id', referenceId);
      url.searchParams.set('api_key', apiKey.trim());
    }
    if (closed) return;
    providerSocket = new WebSocketImpl(url.toString(), {
      maxPayload: MAX_PROVIDER_MESSAGE_BYTES, perMessageDeflate: false,
      followRedirects: false, handshakeTimeout: STARTUP_TIMEOUT_MS,
    });
    providerSocket.on('open', onProviderOpen);
    providerSocket.on('message', onProviderMessage);
    providerSocket.on('close', onProviderClose);
    providerSocket.on('error', onProviderError);
    if (providerSocket.readyState === 1) queueMicrotask(onProviderOpen);
    if (provider === 'hume') timer(humeSilence, 100);
    await ready;
  })();

  const outcome = await Promise.race([
    startup.then(() => 'ready', () => 'failed'), stopped.then(() => 'stopped'),
  ]);
  if (outcome === 'failed') fail('provider_startup_failed');
  if (closed) {
    await finalization;
    const error = new Error('Voice session could not start.');
    error.code = 'VOICE_STARTUP_FAILED';
    throw error;
  }
  return { close: (reason = 'server_close') => finish(/^[a-z0-9_-]{1,48}$/.test(reason) ? reason : 'server_close') };
}

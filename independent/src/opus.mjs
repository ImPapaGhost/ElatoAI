// Adapted from ElatoAI's server/cloudflare/src/opus.ts (MIT).
// The bundled Opus codec retains the Xiph.Org/Opus BSD notices in vendor/.
import { readFile } from 'node:fs/promises';

export const OPUS_SAMPLE_RATE = 24_000;
export const OPUS_FRAME_SAMPLES = 2_880;
export const OPUS_FRAME_SIZE_BYTES = OPUS_FRAME_SAMPLES * 2;
const MAX_PACKET_SIZE = 8_192;
const MAX_INPUT_BYTES = 1024 * 1024;
let exportsPromise;

async function getCodecExports() {
  exportsPromise ??= readFile(new URL('../vendor/opus.wasm', import.meta.url))
    .then((bytes) => WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: {
        fd_seek() { return 0; },
        fd_write() { return 0; },
        fd_close() { return 0; },
        proc_exit() { throw new Error('Opus codec stopped.'); },
      },
      env: { emscripten_notify_memory_growth() {} },
    }))
    .then(({ instance }) => instance.exports);
  return exportsPromise;
}

class OpusEncoder {
  constructor(wasm) {
    this.wasm = wasm;
    this.allocations = [];
    this.closed = false;
    try {
      this.packetPtr = this.allocate(MAX_PACKET_SIZE);
      this.pcmPtr = this.allocate(OPUS_FRAME_SIZE_BYTES);
      this.encoderPtr = this.allocate(wasm.opus_encoder_get_size(1));
      this.reset();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  allocate(length) {
    const ptr = this.wasm.malloc(length);
    if (!ptr) throw new Error('Opus codec memory is unavailable.');
    this.allocations.push(ptr);
    return ptr;
  }

  reset() {
    if (this.closed) return;
    // Reinitializing the already allocated state resets prediction between
    // replies, matching the Cardputer's OPUS_RESET_STATE handoff.
    if (this.wasm.opus_encoder_init(this.encoderPtr, OPUS_SAMPLE_RATE, 1, 2048) < 0) {
      throw new Error('Opus codec could not initialize.');
    }
  }

  encode(frame) {
    if (this.closed) throw new Error('Opus codec is closed.');
    new Uint8Array(this.wasm.memory.buffer).set(frame, this.pcmPtr);
    const length = this.wasm.opus_encode(
      this.encoderPtr, this.pcmPtr, OPUS_FRAME_SAMPLES,
      this.packetPtr, MAX_PACKET_SIZE,
    );
    if (length <= 0) throw new Error('Opus audio encoding failed.');
    // Always copy: subsequent encodes and WASM memory growth must never mutate
    // packets already handed to WebSocket.send().
    return new Uint8Array(this.wasm.memory.buffer)
      .slice(this.packetPtr, this.packetPtr + length);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const ptr of this.allocations) this.wasm.free(ptr);
    this.allocations = [];
  }
}

export async function createOpusPacketizer(sendPacket) {
  if (typeof sendPacket !== 'function') throw new TypeError('sendPacket is required.');
  const encoder = new OpusEncoder(await getCodecExports());
  const frame = new Uint8Array(OPUS_FRAME_SIZE_BYTES);
  let pendingBytes = 0;
  let closed = false;

  return {
    push(pcm) {
      if (closed) return;
      if (!(pcm instanceof Uint8Array)) throw new TypeError('PCM must be bytes.');
      if (pcm.byteLength > MAX_INPUT_BYTES) throw new RangeError('PCM chunk is too large.');
      let offset = 0;
      while (!closed && offset < pcm.byteLength) {
        const count = Math.min(frame.byteLength - pendingBytes, pcm.byteLength - offset);
        frame.set(pcm.subarray(offset, offset + count), pendingBytes);
        pendingBytes += count;
        offset += count;
        if (pendingBytes === frame.byteLength) {
          pendingBytes = 0;
          sendPacket(encoder.encode(frame));
        }
      }
    },

    flush(padFinalFrame = false) {
      if (closed || pendingBytes === 0) return;
      if (!padFinalFrame) {
        pendingBytes = 0;
        return;
      }
      if (pendingBytes % 2 !== 0) throw new Error('PCM ended with an incomplete sample.');
      frame.fill(0, pendingBytes);
      pendingBytes = 0;
      sendPacket(encoder.encode(frame));
    },

    reset() {
      if (closed) return;
      pendingBytes = 0;
      encoder.reset();
    },

    bufferedBytes() { return pendingBytes; },

    close() {
      if (closed) return;
      closed = true;
      pendingBytes = 0;
      encoder.close();
    },
  };
}

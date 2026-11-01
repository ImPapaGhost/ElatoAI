import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createOpusPacketizer, OPUS_SAMPLE_RATE,
  OPUS_FRAME_SAMPLES, OPUS_FRAME_SIZE_BYTES,
} from '../src/opus.mjs';

function tone(length = OPUS_FRAME_SIZE_BYTES, phase = 0) {
  const samples = new Int16Array(length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin((i + phase) * 2 * Math.PI * 440 / OPUS_SAMPLE_RATE) * 4000);
  }
  return new Uint8Array(samples.buffer);
}

async function makeDecoder() {
  const bytes = await readFile(new URL('../vendor/opus.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {
    wasi_snapshot_preview1: {
      fd_seek() { return 0; }, fd_write() { return 0; }, fd_close() { return 0; }, proc_exit() {},
    },
    env: { emscripten_notify_memory_growth() {} },
  });
  const wasm = instance.exports;
  const decoder = wasm.malloc(wasm.opus_decoder_get_size(1));
  const packetPtr = wasm.malloc(8192);
  const pcmPtr = wasm.malloc(OPUS_FRAME_SIZE_BYTES);
  assert.equal(wasm.opus_decoder_init(decoder, OPUS_SAMPLE_RATE, 1), 0);
  return (packet) => {
    new Uint8Array(wasm.memory.buffer).set(packet, packetPtr);
    return wasm.opus_decode(decoder, packetPtr, packet.length, pcmPtr, OPUS_FRAME_SAMPLES, 0);
  };
}

test('one exact frame emits immediately and decodes to 120ms of mono audio', async (t) => {
  const packets = [];
  const codec = await createOpusPacketizer((packet) => packets.push(packet));
  t.after(() => codec.close());
  codec.push(tone());
  assert.equal(packets.length, 1);
  assert.equal(codec.bufferedBytes(), 0);
  assert.ok(packets[0].length > 0 && packets[0].length <= 1275);
  assert.equal((await makeDecoder())(packets[0]), OPUS_FRAME_SAMPLES);
  codec.flush(true);
  assert.equal(packets.length, 1);
});

test('arbitrary chunk boundaries preserve frames and pad only the final samples', async (t) => {
  const packets = [];
  const codec = await createOpusPacketizer((packet) => packets.push(packet));
  t.after(() => codec.close());
  const pcm = tone(OPUS_FRAME_SIZE_BYTES * 2 + 20);
  for (let offset = 0; offset < pcm.length; offset += 137) {
    codec.push(pcm.subarray(offset, Math.min(offset + 137, pcm.length)));
  }
  assert.equal(packets.length, 2);
  assert.equal(codec.bufferedBytes(), 20);
  codec.flush(true);
  assert.equal(packets.length, 3);
  assert.equal(codec.bufferedBytes(), 0);
  const decode = await makeDecoder();
  for (const packet of packets) assert.equal(decode(packet), OPUS_FRAME_SAMPLES);
});

test('encoded packets are independent of subsequent WASM writes', async (t) => {
  const packets = [];
  const codec = await createOpusPacketizer((packet) => packets.push(packet));
  t.after(() => codec.close());
  codec.push(tone());
  const firstCopy = Uint8Array.from(packets[0]);
  codec.push(tone(OPUS_FRAME_SIZE_BYTES * 3, 110));
  assert.deepEqual(packets[0], firstCopy);
  assert.notEqual(packets[0].buffer, packets[1].buffer);
});

test('reset discards pending data and resets prediction for the next reply', async (t) => {
  const packets = [];
  const codec = await createOpusPacketizer((packet) => packets.push(packet));
  t.after(() => codec.close());
  codec.push(tone());
  codec.push(tone(100));
  codec.reset();
  assert.equal(codec.bufferedBytes(), 0);
  codec.push(tone());
  assert.deepEqual(packets[1], packets[0]);
});

test('un-padded flush discards partial PCM without emitting another packet', async (t) => {
  const packets = [];
  const codec = await createOpusPacketizer((packet) => packets.push(packet));
  t.after(() => codec.close());
  codec.push(tone(100));
  codec.flush();
  assert.equal(codec.bufferedBytes(), 0);
  assert.equal(packets.length, 0);
});

test('incomplete final samples and unreasonable chunks are rejected', async (t) => {
  const codec = await createOpusPacketizer(() => {});
  t.after(() => codec.close());
  assert.throws(() => codec.push('not PCM'), /PCM must be bytes/);
  assert.throws(() => codec.push(new Uint8Array(1024 * 1024 + 1)), /too large/);
  codec.push(new Uint8Array(1));
  assert.throws(() => codec.flush(true), /incomplete sample/);
  codec.reset();
  codec.flush(true);
});

test('two sessions own independent encoder state and close is idempotent', async () => {
  const leftPackets = [];
  const rightPackets = [];
  const [left, right] = await Promise.all([
    createOpusPacketizer((packet) => leftPackets.push(packet)),
    createOpusPacketizer((packet) => rightPackets.push(packet)),
  ]);
  left.push(tone());
  right.push(tone());
  assert.deepEqual(leftPackets[0], rightPackets[0]);
  left.close();
  left.close();
  left.push(tone());
  left.flush(true);
  left.reset();
  assert.equal(leftPackets.length, 1);
  right.push(tone());
  assert.equal(rightPackets.length, 2);
  right.close();
});

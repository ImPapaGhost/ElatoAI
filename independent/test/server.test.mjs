import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { WebSocket } from "ws";
import { createAppServer } from "../src/server.mjs";
import { readConfig, publicConfig } from "../src/config.mjs";
import { StoreError } from "../src/store.mjs";

const ownerId = "11111111-1111-1111-1111-111111111111";
const deviceId = "22222222-2222-2222-2222-222222222222";
const deviceToken = "a".repeat(43);
const testConfig = {
  configured: true, missing: [], appName: "Private Voice", appOrigin: "http://localhost:3000",
  geminiApiKey: "provider-secret-must-stay-private", model: "gemini-2.5-flash-native-audio-preview-12-2025",
  sessionSeconds: 240, dailyVoiceSeconds: 600,
};

async function fixture(t, overrides = {}) {
  const calls = { leases: [], finished: [], transcripts: [], devices: [], signIns: 0, voice: 0, contexts: 0 };
  let settlementComplete;
  const settled = new Promise(resolve => { settlementComplete = resolve; });
  const store = {
    async signIn(email, password) {
      calls.signIns++;
      assert.equal(email, "owner@example.com");
      assert.equal(password, "my-password");
      return { access_token: "owner-access-token", refresh_token: "owner-refresh-token", expires_in: 3600 };
    },
    async refresh(token) {
      assert.equal(token, "valid-refresh-token");
      return { access_token: "owner-access-token", refresh_token: "new-refresh-token", expires_in: 3600 };
    },
    async signOut() {},
    async authenticateOwner(token) {
      if (token !== "owner-access-token") throw new StoreError(401, "Sign in.");
      return { id: ownerId, email: "owner@example.com" };
    },
    async getDashboard(id) {
      assert.equal(id, ownerId);
      return { settings: {}, devices: [], usage: { used_seconds: 0, limit_seconds: 600 }, messages: [] };
    },
    async saveSettings(id, value) { assert.equal(id, ownerId); return value; },
    async createDevice(id, value) {
      assert.equal(id, ownerId);
      calls.devices.push(value);
      return { device: { id: deviceId, ...value, enabled: true }, token: deviceToken };
    },
    async revokeDevice() {},
    async authenticateDevice(token, mac) {
      if (token !== deviceToken || mac !== "AA:BB:CC:DD:EE:FF") throw new StoreError(401, "Invalid device.");
      return { id: deviceId, owner_id: ownerId, mac };
    },
    async getVoiceContext() { calls.contexts++; return { settings: { character_name: "Ghost", voice_name: "Aoede", volume: 70 }, history: [] }; },
    async reserveSession(device) {
      calls.leases.push(device.id);
      return { id: "lease-1", maxSeconds: 120 };
    },
    async finishSession(id, elapsedSeconds) { calls.finished.push({ id, elapsedSeconds }); settlementComplete(); },
    async appendTranscript(...args) { calls.transcripts.push(args); },
    ...overrides.store,
  };
  const voiceFactory = overrides.voiceFactory || (async options => {
    calls.voice++;
    assert.equal(options.maxSeconds, 120);
    options.deviceSocket.send(JSON.stringify({ type: "auth", volume_control: 70 }));
    await options.onTranscript({ role: "user", content: "Hello" });
    return { close() { options.deviceSocket.close(); void options.onEnd({ elapsedSeconds: 2, reason: "closed" }); } };
  });
  const server = createAppServer({ config: { ...testConfig, ...overrides.config }, store, voiceFactory });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeVoiceSessions();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (path, options = {}) => fetch(`${address}${path}`, options);
  return { server, address, request, calls, settled };
}

test("public setup config never serializes secrets", async t => {
  const { request } = await fixture(t);
  const response = await request("/api/config");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.ok(!body.includes(testConfig.geminiApiKey));
  assert.ok(!body.includes("ownerEmail"));
  assert.equal(JSON.parse(body).appName, "Private Voice");
});

test("unconfigured service fails closed without authenticating owner", async t => {
  const { request, calls } = await fixture(t, { config: { configured: false, missing: ["GEMINI_API_KEY"] } });
  const response = await request("/api/login", { method: "POST" });
  assert.equal(response.status, 503);
  assert.equal(calls.signIns, 0);
});

test("cross-origin login is rejected; valid login sets only HttpOnly cookies", async t => {
  const { request, calls } = await fixture(t);
  const payload = { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.invalid" }, body: JSON.stringify({ email: "owner@example.com", password: "my-password" }) };
  assert.equal((await request("/api/login", payload)).status, 403);
  assert.equal(calls.signIns, 0);
  payload.headers.Origin = testConfig.appOrigin;
  const response = await request("/api/login", payload);
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every(value => value.includes("HttpOnly") && value.includes("SameSite=Strict")));
  assert.deepEqual(await response.json(), { signedIn: true });
});

test("dashboard requires an owner cookie and renews expired access with refresh", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/api/dashboard")).status, 401);
  const response = await request("/api/dashboard", { headers: { Cookie: "cv_access=expired; cv_refresh=valid-refresh-token" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.deepEqual((await response.json()).devices, []);
});

test("browser cannot inject provider settings and receives a device token only at creation", async t => {
  const { request, calls } = await fixture(t);
  const headers = { Cookie: "cv_access=owner-access-token", Origin: testConfig.appOrigin, "Content-Type": "application/json" };
  const invalid = await request("/api/settings", { method: "PUT", headers, body: JSON.stringify({ voice_name: "unsupported" }) });
  assert.equal(invalid.status, 400);
  const response = await request("/api/devices", { method: "POST", headers, body: JSON.stringify({ name: "My Cardputer", mac: "AA:BB:CC:DD:EE:FF" }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).token, deviceToken);
  assert.equal(calls.devices.length, 1);
  const dashboard = await (await request("/api/dashboard", { headers })).text();
  assert.ok(!dashboard.includes(deviceToken));
});

test("WebSocket authenticates bearer plus MAC before any allowance reservation", async t => {
  const { address, calls } = await fixture(t);
  const ws = new WebSocket(address.replace("http:", "ws:") + "/ws/esp32");
  const status = await new Promise(resolve => {
    ws.on("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on("error", () => {});
  });
  assert.equal(status, 401);
  assert.equal(calls.leases.length, 0);
  assert.equal(calls.voice, 0);
});

test("quota rejection never starts the voice provider", async t => {
  const { address, calls } = await fixture(t, { store: { async reserveSession() { throw new StoreError(429, "No allowance left."); } } });
  const ws = new WebSocket(address.replace("http:", "ws:") + "/ws/esp32", { headers: { Authorization: `Bearer ${deviceToken}`, "X-Device-Mac": "AA:BB:CC:DD:EE:FF" } });
  const status = await new Promise(resolve => {
    ws.on("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on("error", () => {});
  });
  assert.equal(status, 429);
  assert.equal(calls.voice, 0);
  assert.equal(calls.contexts, 0);
});

test("a history-loading failure refunds its reservation before any provider starts", async t => {
  const { address, calls, settled } = await fixture(t, { store: { async getVoiceContext() { throw new StoreError(503, "Database temporarily unavailable."); } } });
  const ws = new WebSocket(address.replace("http:", "ws:") + "/ws/esp32", { headers: { Authorization: `Bearer ${deviceToken}`, "X-Device-Mac": "AA:BB:CC:DD:EE:FF" } });
  const status = await new Promise(resolve => {
    ws.on("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on("error", () => {});
  });
  assert.equal(status, 503);
  await settled;
  assert.equal(calls.voice, 0);
  assert.deepEqual(calls.finished, [{ id: "lease-1", elapsedSeconds: 0 }]);
});

test("an authenticated but malformed WebSocket handshake refunds its unused reservation", async t => {
  const { address, calls, settled } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const request = http.request(`${address}/ws/esp32`, { headers: {
      Authorization: `Bearer ${deviceToken}`, "X-Device-Mac": "AA:BB:CC:DD:EE:FF",
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "invalid",
    } }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 400);
  await settled;
  assert.equal(calls.leases.length, 1);
  assert.equal(calls.voice, 0);
  assert.deepEqual(calls.finished, [{ id: "lease-1", elapsedSeconds: 0 }]);
});

test("authorized device gets a bounded voice session and settlement once on close", async t => {
  const { address, calls, settled } = await fixture(t);
  const ws = new WebSocket(address.replace("http:", "ws:") + "/ws/esp32", { headers: { Authorization: `Bearer ${deviceToken}`, "X-Device-Mac": "AA:BB:CC:DD:EE:FF" } });
  const [message] = await once(ws, "message");
  assert.equal(JSON.parse(message).type, "auth");
  ws.close();
  await once(ws, "close");
  await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error("Settlement did not finish")), 1000))]);
  assert.equal(calls.leases.length, 1);
  assert.equal(calls.finished.length, 1);
  assert.deepEqual(calls.transcripts[0], [ownerId, deviceId, "user", "Hello"]);
});

test("config rejects paid-model switches, unbounded budgets and unsafe app origins", () => {
  const config = readConfig({
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "secret",
    OWNER_EMAIL: "owner@example.com", APP_ORIGIN: "http://public.example.com", GEMINI_API_KEY: "private",
    GEMINI_MODEL: "arbitrary-paid-model", DAILY_VOICE_SECONDS: "999999", SESSION_SECONDS: "3600",
  });
  assert.equal(config.configured, false);
  assert.ok(config.missing.some(name => name.startsWith("APP_ORIGIN")));
  assert.ok(config.missing.some(name => name.startsWith("GEMINI_MODEL")));
  assert.equal(config.sessionSeconds, 240);
  assert.equal(config.dailyVoiceSeconds, 600);
  assert.ok(!JSON.stringify(publicConfig(config)).includes("private"));
});

test("current Supabase publishable and secret variable names configure the private service", () => {
  const config = readConfig({
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_only", SUPABASE_SECRET_KEY: "sb_secret_test_only",
    OWNER_EMAIL: "owner@example.com", APP_ORIGIN: "https://voice.example.com", GEMINI_API_KEY: "test_only_provider_key",
  });
  assert.equal(config.configured, true);
  assert.equal(config.supabaseAnonKey, "sb_publishable_test_only");
  assert.equal(config.supabaseServiceRoleKey, "sb_secret_test_only");
  assert.ok(!JSON.stringify(publicConfig(config)).includes("sb_secret_"));
});

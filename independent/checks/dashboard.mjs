import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { createAppServer } from "../src/server.mjs";

// Isolated browser QA. No cloud accounts or provider calls are made.
const server = createAppServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 1100 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.locator("#setup-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#email").isDisabled(), true);
  assert.ok((await page.locator("#missing-settings").textContent()).includes("GEMINI_API_KEY"));
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL("../test-results/setup.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), fullPage: true });

  let signedIn = false;
  const token = "demo_device_token_" + "a".repeat(26);
  const settings = { character_name: "Atlas", system_prompt: "You are a thoughtful companion. Keep replies brief and natural.", voice_name: "Aoede", volume: 70 };
  let devices = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let status = 200;
    let body;
    if (path === "/api/config") {
      body = { appName: "Cardputer Voice", configured: true, missing: [], sessionSeconds: 240, dailyVoiceSeconds: 600, voices: ["Aoede", "Kore", "Puck"] };
    } else if (path === "/api/login") {
      assert.deepEqual(request.postDataJSON(), { email: "owner@example.com", password: "local-ui-test-only" });
      signedIn = true;
      body = { signedIn: true };
    } else if (path === "/api/logout") {
      signedIn = false;
      body = { signedIn: false };
    } else if (!signedIn) {
      status = 401; body = { error: "Sign in." };
    } else if (path === "/api/dashboard") {
      body = { settings, devices, usage: { used_seconds: 240, limit_seconds: 600 }, messages: [{ role: "user", content: "Hello, Atlas.", created_at: "2026-10-31T12:00:00Z" }, { role: "assistant", content: "<img src=x onerror=alert(1)> is plain text here.", created_at: "2026-10-31T12:00:02Z" }] };
    } else if (path === "/api/settings") {
      Object.assign(settings, request.postDataJSON()); body = { settings };
    } else if (path === "/api/devices") {
      devices = [{ id: "22222222-2222-2222-2222-222222222222", ...request.postDataJSON(), enabled: true }];
      body = { device: devices[0], token }; status = 201;
    } else if (request.method() === "DELETE") {
      devices[0].enabled = false; body = { revoked: true };
    } else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.reload();
  await page.locator("#login-panel").waitFor({ state: "visible" });
  await page.locator("#email").fill("owner@example.com");
  await page.locator("#password").fill("local-ui-test-only");
  await page.locator("#login-button").click();
  await page.locator("#dashboard").waitFor({ state: "visible" });
  assert.equal(await page.locator("#password").inputValue(), "");
  assert.equal(await page.locator("#quota-remaining").textContent(), "6 min");
  assert.equal(await page.locator("#messages img").count(), 0);
  assert.ok((await page.locator("#messages").textContent()).includes("<img src=x"));
  await page.locator("#character-name").fill("Scout");
  await page.locator("#save-settings-button").click();
  await page.waitForFunction(() => document.querySelector("#feedback").textContent.includes("saved"));
  assert.equal(settings.character_name, "Scout");
  await page.locator("#device-name").fill("Jake's Cardputer");
  await page.locator("#device-mac").fill("AA:BB:CC:DD:EE:FF");
  await page.locator("#add-device-button").click();
  await page.locator("#device-secret").waitFor({ state: "visible" });
  assert.equal(await page.locator("#device-token").textContent(), token);
  assert.equal(await page.locator("#device-name").isDisabled(), true);
  await page.locator("#dismiss-token-button").click();
  assert.equal(await page.locator("#device-token").textContent(), "");
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.screenshot({ path: new URL("../test-results/dashboard-desktop.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: new URL("../test-results/dashboard-mobile.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), fullPage: true });
  await page.locator("#logout-button").click();
  await page.locator("#login-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#device-token").textContent(), "");
  assert.deepEqual(errors, []);
  console.log("Browser QA passed: setup, owner login, settings, device-token handling, quota, XSS rendering, mobile layout, logout.");
} finally {
  await browser?.close();
  server.closeVoiceSessions();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

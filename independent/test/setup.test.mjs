import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAppServer } from '../src/server.mjs';

async function fixture(t) {
  const server = createAppServer({ config: { configured: false }, store: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return path => fetch(`${base}${path}`);
}

test('Easy setup needs no dashboard sign-in and serves the bundled installer', async t => {
  const request = await fixture(t);
  for (const path of ['/setup', '/api/index?route=public&path=/setup']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /esp-web-install-button/);
    assert.match(html, /ElevenLabs/);
    assert.match(html, /Hume/);
    assert.ok(!html.includes('SUPABASE_SECRET_KEY'));
  }
  const script = await request('/install-button.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.ok((await script.text()).length > 100_000);
  assert.equal((await request('/installer-LICENSE.txt')).status, 200);
});

test('USB manifest serves the exact credential-free S3 app and matching checksums', async t => {
  const request = await fixture(t);
  const manifest = await (await request('/firmware/manifest.json')).json();
  assert.equal(manifest.builds.length, 1);
  assert.equal(manifest.builds[0].chipFamily, 'ESP32-S3');
  assert.equal(manifest.builds[0].serialType, 'cdc');
  const sums = await (await request('/firmware/SHA256SUMS.txt')).text();
  for (const part of manifest.builds[0].parts) {
    const response = await request(`/firmware/${part.path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /octet-stream/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(sums.includes(`${createHash('sha256').update(bytes).digest('hex')}  ${part.path}`));
    if (part.offset === 0x10000) {
      assert.ok(bytes.includes(Buffer.from('/ws/byok')));
      assert.ok(!bytes.includes(Buffer.from('/ws/esp32\0')));
      assert.ok(!/AIza[A-Za-z0-9_-]{35}/.test(bytes.toString('latin1')));
    }
  }
});

test('the public asset rewrite cannot serve arbitrary project or private firmware paths', async t => {
  const request = await fixture(t);
  for (const path of ['/.env', '/src/server.mjs', '/firmware/PersonalConfig.h', '/firmware/private.bin']) {
    const response = await request(`/api/index?route=public&path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 404);
  }
});

test('only setup pages allow the paired LAN port, and static dashboard CSP stays strict', async t => {
  const request = await fixture(t);
  assert.ok((await request('/settings')).headers.get('content-security-policy').includes('http://*:8080'));
  assert.ok(!(await request('/')).headers.get('content-security-policy').includes('http://*:8080'));
  const deployment = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const path of ['/', '/index.html']) {
    const policy = deployment.headers.find(item => item.source === path)?.headers
      .find(item => item.key === 'Content-Security-Policy')?.value;
    assert.ok(policy?.includes("connect-src 'self';"));
    assert.ok(!policy.includes('http://*:8080'));
  }
  assert.ok(!deployment.headers.find(item => item.source === '/(.*)').headers
    .some(item => item.key === 'Content-Security-Policy'));
});

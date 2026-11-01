import http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import { readConfig, publicConfig, VOICES } from "./config.mjs";
import { createStore, StoreError } from "./store.mjs";
import { startVoiceSession } from "./voice.mjs";

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function headers(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", CSP);
}

function json(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function route(req) {
  const url = new URL(req.url, "http://localhost");
  // Vercel rewrites include explicit route metadata; local requests use their
  // normal path. Never derive an upstream endpoint from request parameters.
  if (url.pathname === "/api/index" && url.searchParams.has("route")) {
    const name = url.searchParams.get("route");
    if (name === "voice") return "/ws/esp32";
    const id = name === "devices" && url.searchParams.get("id");
    return `/api/${name}${id ? `/${id}` : ""}`;
  }
  return url.pathname;
}

function cookieJar(req) {
  const jar = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      try { jar[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1)); }
      catch { /* Ignore malformed cookies. */ }
    }
  }
  return jar;
}

function setSessionCookies(res, session, config) {
  const secure = config.appOrigin.startsWith("https:") ? "; Secure" : "";
  const suffix = `; HttpOnly; SameSite=Strict; Path=/${secure}`;
  const accessAge = session ? Math.min(Number(session.expires_in) || 3600, 3600) : 0;
  res.setHeader("Set-Cookie", [
    `cv_access=${encodeURIComponent(session?.access_token || "")}; Max-Age=${accessAge}${suffix}`,
    `cv_refresh=${encodeURIComponent(session?.refresh_token || "")}; Max-Age=${session ? 604800 : 0}${suffix}`,
  ]);
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    throw new StoreError(415, "Send a JSON request.");
  }
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 8192) throw new StoreError(413, "Request is too large.");
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new StoreError(400, "Invalid JSON request."); }
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests", 503: "Service Unavailable" }[status] || "Service Unavailable";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createAppServer(options = {}) {
  const config = options.config || readConfig();
  const store = options.store || createStore(config);
  const voiceFactory = options.voiceFactory || startVoiceSession;
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });

  async function owner(req, res) {
    const jar = cookieJar(req);
    if (jar.cv_access) {
      try { return await store.authenticateOwner(jar.cv_access); }
      catch (error) { if (error.status !== 401) throw error; }
    }
    if (jar.cv_refresh) {
      const session = await store.refresh(jar.cv_refresh);
      const user = await store.authenticateOwner(session.access_token);
      setSessionCookies(res, session, config);
      return user;
    }
    throw new StoreError(401, "Sign in to your private dashboard.");
  }

  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const path = route(req);
      if (req.method === "GET" && path === "/api/config") {
        return json(res, 200, publicConfig(config));
      }
      if (req.method === "GET" && path === "/healthz") {
        return json(res, config.configured ? 200 : 503, { configured: config.configured });
      }
      if (req.method === "GET" && STATIC_FILES.has(path)) {
        const [file, type] = STATIC_FILES.get(path);
        const content = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { "Content-Type": type });
        return res.end(content);
      }
      if (!path.startsWith("/api/")) return json(res, 404, { error: "Page not found." });
      if (!config.configured) return json(res, 503, { error: "Finish configuring the private server first." });
      if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== config.appOrigin) {
        throw new StoreError(403, "Open the dashboard at its configured address and try again.");
      }
      if (path === "/api/login" && req.method === "POST") {
        const body = await readJson(req);
        if (typeof body.email !== "string" || typeof body.password !== "string" || body.password.length > 256) {
          throw new StoreError(400, "Enter your email and password.");
        }
        const session = await store.signIn(body.email, body.password);
        await store.authenticateOwner(session.access_token);
        setSessionCookies(res, session, config);
        return json(res, 200, { signedIn: true });
      }
      if (path === "/api/logout" && req.method === "POST") {
        const jar = cookieJar(req);
        setSessionCookies(res, null, config);
        if (jar.cv_access) await store.signOut(jar.cv_access).catch(() => {});
        return json(res, 200, { signedIn: false });
      }
      const user = await owner(req, res);
      if (path === "/api/dashboard" && req.method === "GET") {
        return json(res, 200, await store.getDashboard(user.id));
      }
      if (path === "/api/settings" && req.method === "PUT") {
        const body = await readJson(req);
        if (!VOICES.includes(body.voice_name)) throw new StoreError(400, "Choose a supported voice.");
        const settings = await store.saveSettings(user.id, body);
        return json(res, 200, { settings });
      }
      if (path === "/api/devices" && req.method === "POST") {
        return json(res, 201, await store.createDevice(user.id, await readJson(req)));
      }
      const devicePath = /^\/api\/devices\/([a-f0-9-]{36})$/i.exec(path);
      if (devicePath && req.method === "DELETE") {
        await store.revokeDevice(user.id, devicePath[1]);
        for (const entry of sessions.values()) {
          if (entry.deviceId === devicePath[1]) entry.controller.close("device-revoked");
        }
        return json(res, 200, { revoked: true });
      }
      return json(res, 404, { error: "Endpoint not found." });
    } catch (error) {
      const known = error instanceof StoreError;
      json(res, known ? error.status : 500, { error: known ? error.message : "The request could not be completed. Try again." });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    // Node may emit socket errors while authentication is awaiting Supabase.
    socket.on("error", () => {});
    let lease;
    let settled = false;
    let startedAt;
    let authTimer;
    async function finish({ elapsedSeconds = 0 } = {}) {
      if (settled) return;
      settled = true;
      clearInterval(authTimer);
      if (lease) {
        try { await store.finishSession(lease.id, elapsedSeconds); }
        catch { console.error("Voice allowance settlement failed; the reserved limit remains charged."); }
      }
    }
    (async () => {
      if (route(req) !== "/ws/esp32") return rejectUpgrade(socket, 404);
      if (!config.configured) return rejectUpgrade(socket, 503);
      const auth = req.headers.authorization || "";
      if (!/^Bearer [A-Za-z0-9_-]{43,128}$/.test(auth)) return rejectUpgrade(socket, 401);
      const token = auth.slice(7);
      const mac = req.headers["x-device-mac"];
      if (typeof mac !== "string" || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(mac)) return rejectUpgrade(socket, 401);
      const device = await store.authenticateDevice(token, mac);
      if (socket.destroyed) return;
      lease = await store.reserveSession(device);
      // handleUpgrade may reject a malformed handshake by ending the raw
      // socket without invoking its callback. Release that reservation too.
      socket.once("close", () => {
        void finish({ elapsedSeconds: startedAt ? Math.ceil((Date.now() - startedAt) / 1000) : 0 });
      });
      if (socket.destroyed) return finish();
      const context = await store.getVoiceContext(device);
      if (socket.destroyed) return finish();
      wss.handleUpgrade(req, socket, head, ws => {
        startedAt = Date.now();
        ws.on("error", () => {});
        ws.on("close", () => {
          sessions.delete(ws);
          void finish({ elapsedSeconds: Math.ceil((Date.now() - startedAt) / 1000) });
        });
        void voiceFactory({
          deviceSocket: ws,
          context,
          apiKey: config.geminiApiKey,
          model: config.model,
          maxSeconds: Math.min(config.sessionSeconds, lease.maxSeconds),
          onTranscript: ({ role, content }) => store.appendTranscript(device.owner_id, device.id, role, content),
          onEnd: finish,
        }).then(controller => {
          if (ws.readyState !== WebSocket.OPEN) return controller.close("device-disconnected");
          sessions.set(ws, { controller, deviceId: device.id });
          // Revocation applies across instances too, within one polling window.
          authTimer = setInterval(() => {
            void store.authenticateDevice(token, mac).catch(() => controller.close("device-revoked"));
          }, 30000);
          authTimer.unref?.();
        }).catch(async () => {
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Voice connection could not start");
          await finish({ elapsedSeconds: Math.ceil((Date.now() - startedAt) / 1000) });
        });
      });
    })().catch(async error => {
      await finish();
      rejectUpgrade(socket, error instanceof StoreError ? error.status : 503);
    });
  });

  server.closeVoiceSessions = () => {
    for (const { controller } of sessions.values()) controller.close("server-stopping");
    for (const ws of wss.clients) ws.close(1001, "Server stopping");
  };
  server.on("close", () => {
    server.closeVoiceSessions();
    wss.close();
  });
  return server;
}

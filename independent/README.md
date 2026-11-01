# Cardputer Voice — private first

A personal voice service using your own Supabase project, Vercel deployment,
and Google Gemini Live API project. It does not call ElatoAI's hosted service.
The first version allows one owner and one enabled Cardputer. Public signup,
payments, and shared community usage are intentionally outside this version.

Status: implemented and locally tested; cloud deployment and a real Gemini /
Cardputer conversation still need to be verified with your accounts. The working
ElatoAI-hosted firmware remains the default build.

## What runs where

- **Vercel:** private dashboard, API, and the Cardputer's WebSocket voice bridge.
- **Supabase:** owner authentication, character settings, device credential hashes,
  a small transcript history, and authoritative usage accounting.
- **Gemini Live:** 16 kHz microphone input and spoken replies. Replies are encoded
  to Opus as they arrive for the existing Cardputer audio driver.

Vercel now supports WebSockets on all plans. Hobby connections have a five-minute
function limit; this service caps sessions at four minutes and normally rotates
between replies. Text history is restored on the next connection, although a
short reconnect pause is expected. This is not a promise of seamless long calls.
[Vercel WebSockets](https://vercel.com/docs/functions/websockets) ·
[Hobby limits](https://vercel.com/docs/plans/hobby)

## 1. Create your free accounts

1. Create a **new Free Supabase project**. Keep its database password private.
2. In Supabase **Authentication → Users**, create your own user with an email and
   password and confirm the email. Disable new-user signups in Authentication
   settings. The app also independently checks the configured owner email.
3. In the SQL Editor, run [supabase/schema.sql](supabase/schema.sql). Run only this
   schema in the new project, not the upstream demo migrations.
4. Create a [Google AI Studio](https://aistudio.google.com/) API key in a project
   on the **Free tier, with billing not enabled**. Check that its Live audio model
   has available quota. Do not paste the key into chat or put it in the Cardputer.
5. Use a personal, non-commercial **Vercel Hobby** project for the deployment.

The app defaults to a 10-minute daily connection budget and one voice session at
a time. This is our extra cap, not Google's promised allowance. Google's quotas
can be lower and can change. There is no paid provider fallback. An app cannot
make an already paid Google project free, so verify the Google project's tier.

Google's free tier may use submitted content to improve its products. Supabase
Free projects can pause after inactivity. Vercel Hobby is for personal,
non-commercial use. Review the current terms before changing the audience or
business model:
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
[Google quotas](https://ai.google.dev/gemini-api/docs/rate-limits) ·
[Supabase pricing](https://supabase.com/pricing).

## 2. Deploy the website and voice bridge

In Vercel, import this GitHub repository and use the branch containing this
directory (`codex/independent-cardputer` during the private preview).

- Set **Root Directory** to `independent`.
- Use the **Other** framework preset and Node.js **24 LTS**.
- Use `npm ci` to install. This app has no frontend build step.
- Add the environment variables listed in [.env.example](.env.example).
- `APP_ORIGIN` must be the exact production origin, such as
  `https://your-app.vercel.app`, with no path or trailing slash.
- `OWNER_EMAIL` must match the Supabase user you created.
- Keep `SUPABASE_SECRET_KEY` and `GEMINI_API_KEY` in server environment
  settings. They are never sent to the browser or device.
- Keep the Google project on Free, and keep Vercel/Supabase on their free plans.

The required Supabase values are the project's URL, publishable key, and secret
key. The publishable key handles password authentication; only the server uses
the secret key. Copy them from **Settings → API Keys → Publishable and secret API
keys**. Legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` variable names
remain accepted for compatibility, but new deployments should use the new keys.

Deploy, then open your production URL. The setup screen lists missing variable
names without revealing their values. If Vercel deployment protection applies
to the production URL, configure access so the Cardputer can reach it: the voice
endpoint performs its own device-token authentication. Preview sign-in protection
cannot be completed by an ESP32.

The existing `vercel.json` routes the dashboard API and `/ws/esp32` to one Node
HTTP server. No separate Cloudflare, Deno, Railway, or paid OpenAI service is
required by this version.

## 3. Set up your character and device

1. Sign into your dashboard with the Supabase owner email/password.
2. Set the character name, instructions, voice, and speaker volume. Save them.
3. Find your Cardputer's station Wi-Fi MAC address in its USB upload output or
   your router's connected-device list. Use this Cardputer's address, not an
   example from someone else's setup.
4. Add the Cardputer in the dashboard. Save its random **device token**, which
   is shown only once. The database stores a hash of the token.

The token authorizes just this device on your service. It is different from
your Gemini key, Supabase key, password, and old ElatoAI token. Disable the device
in the dashboard to revoke it. If you lose its token, disable that device entry
and create a new one.

## 4. Point the personal firmware at your deployment

Copy `firmware-arduino/include/PersonalConfig.example.h` to
`firmware-arduino/include/PersonalConfig.h`. Fill in:

- `CARDPUTER_SERVER_HOST`: your production hostname, without `https://` or a path.
- `CARDPUTER_DEVICE_TOKEN`: the token issued in step 3.
- `CARDPUTER_SERVER_CA_CERT`: the PEM certificate of a trusted CA for that host.
  Use the deployment's valid issuing/root CA chain, not a placeholder or a leaf
  certificate. HTTPS and WSS certificate verification stay enabled.

`PersonalConfig.h` is ignored by Git. This **personal binary embeds the device
token**: keep it private. Do not upload it to a public release or Launcher catalog.
A future public version needs interactive device pairing instead of a shared token.

From `firmware-arduino`, using the Python/PlatformIO environment from the main
installation guide, build and upload:

```powershell
python -m platformio run -e m5stack-cardputer-independent
python -m platformio device list
python -m platformio run -e m5stack-cardputer-independent -t upload --upload-port COM3
```

Replace `COM3` with the Cardputer's port. Close any serial monitor first. This
direct USB flash replaces the installed firmware/Launcher. A real deployment
hostname, CA, and device token are required before flashing; placeholder builds
are compilation checks only.

On first network setup, join **CARDPUTER-SETUP** and open
`http://192.168.4.1/wifi`. Save your 2.4 GHz Wi-Fi network. Existing saved networks
can be reused. Restart, wait for the greeting and **LISTENING**, then speak.

Private mode takes its credential from `PersonalConfig.h`; an old ElatoAI token
in NVS is not used. To rotate the personal token, update this header and reflash.
Character changes apply on the next voice connection. G0 sleep/wake still works.

## How the usage cap works

- The daily budget counts **connected voice time**, including listening and
  silence, not only the time the character speaks. It resets at midnight UTC.
- Before starting Gemini, a transaction reserves at most one session's remaining
  budget. Concurrent requests cannot both open a session for the owner.
- A normal disconnect refunds unused reserved seconds. A crashed or abandoned
  connection consumes its reservation so repeated failures cannot bypass the cap.
- When the cap is exhausted, new voice connections are rejected before contacting
  Gemini or loading conversation history. Repeated connection failures increase
  the device's retry delay up to five minutes to reduce unnecessary free-tier
  traffic. Power off/sleep the Cardputer when you are done talking.
- Default limits are 600 seconds/day and 240 seconds/session. The private server
  accepts at most 1,800 seconds/day and 240 seconds/session; provider limits still
  apply. No automatic plan upgrade or provider fallback is implemented.

Only text transcripts are stored, with the most recent 200 messages retained.
Raw microphone audio is not stored by this app. Google still processes the audio
under the terms of the Google project you use.

## Local development and checks

From `independent`:

```bash
npm ci
```

Copy `.env.example` to `.env`, fill it with your own test-project settings, and
set `APP_ORIGIN=http://localhost:3000`. Then run:

```bash
npm start
npm test
npm run check
```

Without cloud credentials, `npm start` still serves the setup-needed screen;
authenticated APIs and voice connections remain unavailable. It listens only on
loopback. Automated tests inject fake providers and do not consume AI quota.

Tests include real embedded PostgreSQL execution of the schema/RLS/usage RPCs
through PGlite, HTTP/WebSocket authentication, and real Opus WASM encode/decode.
PGlite uses one database connection; a live cloud concurrency test is still needed.

For browser QA, install Chrome or a Playwright browser and run `npm run test:ui`.
The check uses an isolated browser with mock API responses, verifies desktop and
mobile layouts, and saves screenshots under ignored `test-results/`.

Before considering this live, verify with the actual accounts: owner login,
device registration/revocation, one real spoken conversation, a reconnect with
history, the usage cap, and TLS on the Cardputer. Cloud deployment, provider
availability, and hardware behavior are not proven by local tests alone.

## Credits

Based on the [ElatoAI](https://github.com/akdeb/ElatoAI) project and its Cardputer
port. The default hosted edition remains available separately. See the root
[LICENSE](../LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

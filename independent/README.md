# Cardputer Voice — easy setup

Use the Cardputer's keyboard to set up Wi-Fi and your own voice-provider key.
The Easy edition uses the shared Cardputer Voice bridge, independently of
ElatoAI's hosted service. You do not need your own Supabase project, Vercel
deployment, ElatoAI account, or private firmware configuration file.

Status: the original private-owner Gemini/Cardputer path has been verified.
The new Easy installation, provider entry, and cloned-voice adapters have local
automated checks; the new Easy hardware setup path is still awaiting verification.

## Easy setup for your Cardputer

1. **Install the Easy edition.** Plug the original M5Stack Cardputer into a
   computer using a USB-C data cable. Open the
   [web installer](https://cardputer-voice.vercel.app/setup) in desktop Chrome or
   Edge and follow its USB installation steps. This replaces the installed
   firmware, including Launcher if present.
2. **Connect Wi-Fi on the Cardputer.** Choose your 2.4 GHz network, type its
   password, and press Enter. Use `;` / `.` to move through network choices, or
   Tab to enter a network name manually.
3. **Choose a provider.** Select Gemini, ElevenLabs, or Hume, and type your own
   API key. The key is masked on-screen. ElevenLabs also asks for an existing
   Agent ID; Hume asks for an existing Config ID. See the requirements below.
4. **Finish setup and talk.** Press Enter through the remaining prompts. When
   the Cardputer greets you and shows **LISTENING**, say a short sentence and
   pause for the reply. Wait for LISTENING before speaking again.

Wi-Fi and provider settings stay saved for later boots. Hold **Fn + W for two
seconds** to reopen setup. On the saved-Wi-Fi screen, press **Enter** to keep the
network and change only the provider/key, or **Tab** to change Wi-Fi too.
Backspace edits a field; **Ctrl + Backspace** clears it. G0 sleep/wake still works.

If keyboard Wi-Fi setup is unavailable, press Esc to use browser Wi-Fi setup:
join **CARDPUTER-SETUP** from a phone or computer, then open
`http://192.168.4.1/wifi` on that same device. Save the 2.4 GHz network using
**Manual Connect**, then reset the Cardputer. Reopen setup with Fn + W to enter
the provider details. Connecting a phone to the hotspot does not connect your
computer to it.

### What you need from your voice provider

- **Gemini:** a [Google AI Studio](https://aistudio.google.com/) API key with
  access and available quota for the service's supported Gemini Live model.
  This option uses Gemini's built-in voice, not an uploaded voice clone.
- **ElevenLabs:** your API key and an **Agent ID** from your ElevenLabs account.
  Configure the agent's personality, first greeting, and desired voice there.
  Set user input to **`pcm_16000`** and output to a **PCM** format, preferably
  `pcm_24000`. You must enable **`agent_response_complete`** in the agent's
  `client_events` configuration. The bridge waits for that event after the audio,
  instead of treating the earlier text response as the end of speech.
- **Hume:** your API key and an existing **EVI Config ID** from your Hume account.
  Configure the desired voice there. The bridge handles 16 kHz microphone input
  and converts Hume's returned mono PCM WAV audio for the Cardputer speaker.

For a cloned voice, create or select a clone supported by your provider account,
attach it to the ElevenLabs agent or Hume configuration, and enter that existing
ID on the Cardputer. This reuses the original ElatoAI provider integrations; it
does not create a new voice-cloning engine or clone a voice inside Gemini Live.

**Provider costs and permissions still apply.** A provider may require a paid
plan for an agent, cloned voice, or API access. This service does not grant those
features or guarantee that they are free. If using Gemini's Free tier, check
your Google project's billing status and current quota; our cap is not Google's
promised allowance. There is no automatic paid-provider fallback.

[ElevenLabs audio/event setup](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events)
· [ElevenLabs agent authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication)
· [Hume EVI configurations](https://dev.hume.ai/voice/reference/speech-to-speech-evi/chat)
· [Gemini quotas](https://ai.google.dev/gemini-api/docs/rate-limits)

### Shared preview limits and privacy

The shared Easy service has deliberately small limits:

- **10 minutes per provider key per UTC day** (600 seconds).
- **20 minutes total across all guests per UTC day** (1,200 seconds).
- At most **100 accepted connection attempts per UTC day** across the service.
- At most **two simultaneous sessions** overall, and one active session per key.
- Each connection lasts at most **four minutes** (240 seconds), then reconnects
  when allowance remains. A short reconnect pause is expected.

The budget counts connection time, including listening and silence. A normal
disconnect refunds unused reserved seconds; failed or abandoned connections
cannot bypass the cap. Accepted attempts are not refunded. Sleep/power off the
Cardputer when you are finished. The service may be unavailable because a shared
cap or a provider's own quota has been reached, even if your key still works.

Your provider key is saved in the Cardputer's NVS settings. The device sends it
to the shared bridge over verified TLS; the bridge uses it in memory for that
connection and authenticates with your chosen provider. The bridge does not
store API keys in Supabase or print them in its logs. Supabase holds only key
fingerprints, bounded usage counters, and session leases for guest
accounting. Guest conversations/history are not saved by this bridge; the voice
provider processes audio under its own terms.

The private-owner dashboard is separate. Guests do not sign into it, receive
owner access, or use the owner's Gemini key if their own key is missing or fails.

### Optional: build the Easy firmware yourself

From `firmware-arduino`, using the Python/PlatformIO environment described in the
[main installation guide](../README.md#cardputer-installation-and-setup):

```powershell
python -m platformio run -e m5stack-cardputer-easy
python -m platformio device list
python -m platformio run -e m5stack-cardputer-easy -t upload --upload-port COM3
```

Replace `COM3` with your device's port and close any serial monitor first. This
target does not require `PersonalConfig.h` and contains no personal API key. Its
application binary is `.pio/build/m5stack-cardputer-easy/firmware.bin`. Do not
confuse it with a private-owner binary containing a device token. Launcher SD
installation of this new Easy target still needs hardware verification.

## Hosting the service / keeping the private-owner edition

The section below is for the person operating the bridge. Ordinary Easy users
can stop after the setup steps above.

### What runs where

- **Vercel:** web installer, private dashboard/API, and WebSocket voice bridge.
- **Supabase:** private-owner authentication/settings/history, plus separate
  guest usage accounting that never stores guest provider keys or conversations.
- **Voice provider:** Gemini Live, an existing ElevenLabs agent, or Hume EVI.
  Provider replies become Opus packets for the existing Cardputer audio driver.

The bridge caps connections at four minutes and normally rotates between replies
before the host deadline. Private-owner Gemini sessions restore text history on
reconnect; guest sessions do not persist history. Provider behavior and quotas
still apply.
[Vercel WebSockets](https://vercel.com/docs/functions/websockets)
· [Vercel Hobby terms/limits](https://vercel.com/docs/plans/hobby)

### 1. Prepare the operator accounts and database

1. Use a Supabase project dedicated to this service. In **Authentication → Users**,
   create and confirm the private owner's email/password user. Disable new-user
   signup; Easy guests do not need Supabase Auth accounts.
2. In Supabase's SQL Editor, apply **both** [supabase/schema.sql](supabase/schema.sql)
   and [supabase/byok.sql](supabase/byok.sql). If the original private schema is
   already installed, apply `byok.sql` alongside it. Both scripts are repeatable.
   Do not apply the upstream ElatoAI demo migrations to this project.
3. For private-owner Gemini voice, create a Google AI Studio API key and check
   the project's tier/model quota. If keeping this project on Free, leave billing
   disabled. The key belongs in server environment settings.
4. Choose a hosting plan appropriate to the service's audience and use. Review
   current [Vercel Hobby terms](https://vercel.com/docs/plans/hobby),
   [Supabase limits](https://supabase.com/pricing), and
   [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) rather than
   promising unlimited free public hosting.

### 2. Configure and deploy your bridge

Import this repository into Vercel, using the branch containing `independent`
(`codex/independent-cardputer` during the preview).

- Root Directory: **`independent`**; framework preset: **Other**; Node.js: **24 LTS**.
- Install command: **`npm ci`**. There is no frontend build step.
- Fill the operator values from [.env.example](.env.example) in Vercel.
- `APP_ORIGIN` is the exact production HTTPS origin, with no path/trailing slash.
- `OWNER_EMAIL` must match the private Supabase user. Keep
  `SUPABASE_SECRET_KEY` and the operator `GEMINI_API_KEY` server-side.
- Use the project's URL, publishable key, and secret key from Supabase
  **Settings → API Keys**. Legacy anon/service-role variable names remain accepted.

The shared public deployment is
[`cardputer-voice.vercel.app`](https://cardputer-voice.vercel.app/setup).
The generic Easy firmware's host and trusted CA live in
[`PublicCardputerConfig.h`](../firmware-arduino/include/PublicCardputerConfig.h).
If operating a different host, update its public hostname/valid CA and the
installer artifacts for that deployment. Those public connection details are
not user credentials.

Production access must allow the Cardputer to reach `/ws/esp32` (private device
token) and `/ws/byok` (the guest's own provider credential). Browser-only preview
sign-in protection cannot be completed by an ESP32. The setup screen lists
missing operator variable names without revealing their values.

Guest limits are fixed in `src/byok-store.mjs` and `supabase/byok.sql`.
`DAILY_VOICE_SECONDS` controls the **private owner's** daily budget, not the guest
allowance. `SESSION_SECONDS` can shorten sessions but cannot exceed 240 seconds.

### 3. Use the private-owner dashboard

1. Sign into the dashboard with the Supabase owner's email/password.
2. Save the character name, instructions, built-in Gemini voice, and volume.
3. Add your Cardputer using its station Wi-Fi MAC from the USB upload output or
   router's device list. Save the random device token shown once.
4. Copy `firmware-arduino/include/PersonalConfig.example.h` to ignored
   `PersonalConfig.h`, then fill your host, valid trusted CA, and that device token.
5. Build/upload **`m5stack-cardputer-independent`** as described below.

```powershell
python -m platformio run -e m5stack-cardputer-independent
python -m platformio run -e m5stack-cardputer-independent -t upload --upload-port COM3
```

This original private target remains available and always uses its own device
token. The separate Easy target uses the guest's provider key. The private binary
embeds a revocable device token and must remain private. Do not publish it in the Launcher
catalog. To rotate its token, disable the old device in the owner dashboard,
create another token, update the ignored header, and reflash.

The private target uses the Cardputer's keyboard Wi-Fi setup too, with the browser
hotspot as a fallback. Existing saved Wi-Fi is reused. Its provider credential
still comes from the private header; the original ElatoAI token in NVS is not used.

Private-owner usage is reserved before opening a provider connection. Normal
disconnects refund unused time; abandoned reservations remain charged. The
default private budget is 600 connected seconds/day and 240 seconds/session,
with configured maxima of 1,800/day and 240/session. Private text history keeps
the latest 200 messages. Raw microphone audio is not stored by this app.

## Local checks and verification

From `independent`, run `npm ci`. For local development, copy `.env.example` to
`.env`, fill test-project values, and use `APP_ORIGIN=http://localhost:3000`.

```bash
npm start
npm test
npm run check
```

Without operator credentials, the setup-needed screen still loads, but voice
connections and private APIs fail closed. Local development listens on loopback.
Tests use fake providers and do not consume AI quota. They cover embedded
PostgreSQL accounting/permissions, owner and guest authorization, audio ordering,
provider formats, connection limits, cleanup, and real Opus WASM encoding.

For browser QA, install Chrome or a Playwright browser and run `npm run test:ui`.
It uses mock API responses and writes screenshots to ignored `test-results/`.

Before marking the new Easy path hardware-verified, check a fresh installation,
keyboard Wi-Fi/key entry, saved-Wi-Fi reuse, each provider with real account
access, completion after the last audio packet, a reconnect, and allowance
exhaustion. Passing local tests does not prove provider account access or a
particular user's clone entitlement.

## Credits

Based on [ElatoAI](https://github.com/akdeb/ElatoAI), its Cardputer port, and its
existing ElevenLabs/Hume connectors. The original ElatoAI-hosted edition remains
available separately. See the root [LICENSE](../LICENSE) and
[third-party notices](THIRD_PARTY_NOTICES.md).

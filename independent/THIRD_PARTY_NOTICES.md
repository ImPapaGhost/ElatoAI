# Third-party notices

This personal service is part of the ElatoAI fork. Retain the repository's
[MIT license and ElatoAI copyright notice](../LICENSE).

The Node Opus packetizer adapts the existing `server/cloudflare/src/opus.ts`.
`vendor/opus.wasm` is copied unchanged from this repository's
`server/cloudflare/src/vendor/opus.wasm` (SHA-256
`d946657d3817d64e852462bcef490ad9fa3f54eb41fe7dd9048f185661f7c386`).
Its bundled Xiph/Opus redistribution notice is in [vendor/COPYING.opus](vendor/COPYING.opus).

Runtime packages retain their own license notices in their installed packages:

- `@google/genai`: Apache-2.0.
- `ws`: MIT.
- `@vercel/functions`: MIT; keeps final transcript and quota writes alive when
  a voice connection closes.

Development-only tools include PGlite (Apache-2.0) and Playwright (Apache-2.0).
`package-lock.json` pins the dependency versions used for this preview.

The Arduino firmware includes additional upstream libraries with their own
licenses. In particular Arduino Audio Tools is GPLv3, WebSockets is LGPLv2.1,
and AsyncTCP/ESPAsyncWebServer are LGPLv3. The copied Wi-Fi manager source carries
CC BY-NC-SA 4.0 notices. The root MIT license does not replace those notices.
This preview is for personal use; review the complete firmware dependencies
before any public binary distribution or commercial version.

# ElatoAI firmware for M5Stack Cardputer

This firmware now supports the original M5Stack Cardputer, Cardputer v1.1,
and Cardputer-Adv as its default PlatformIO target. The original generic
ESP32-S3 devkit target is still available.

The Cardputer build uses the device's built-in:

- 240 x 135 display for connection and conversation status
- microphone for 16 kHz mono PCM input
- speaker for 48 kHz decoded Opus output
- G0 user button for sleep and wake
- battery monitor and USB serial/JTAG interface

M5Stack's microphone and speaker drivers share audio hardware, so the firmware
explicitly hands the bus from one device to the other as ElatoAI changes between
listening and speaking. Speaker data is sent through three rotating PCM buffers
to keep streamed audio valid until M5Unified finishes playing it.

## Requirements

- M5Stack Cardputer, Cardputer v1.1, or Cardputer-Adv
- USB-C data cable
- Python 3.10 or newer
- [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html)
- An ElatoAI account and a registered DIY device when using the default
  `ELATO_MODE`

The project pins its Espressif platform and M5Stack libraries in
`platformio.ini`; no separate Arduino library installation is required.

## Build

From this directory:

```bash
python -m pip install -U platformio
pio run
```

`m5stack-cardputer` is the default environment, so `pio run` builds the
Cardputer image. To build both supported hardware paths:

```bash
pio run -e m5stack-cardputer
pio run -e esp32-s3-devkitc-1
```

## Flash and monitor

Connect the Cardputer over USB, then run:

```bash
pio run -e m5stack-cardputer -t upload
pio device monitor -e m5stack-cardputer
```

The serial monitor runs at 115200 baud. If an upload cannot enter the
bootloader, hold G0 while pressing and releasing Reset, release G0, and retry
the upload command.

## First boot

1. Power on the Cardputer.
2. If no saved network is available, join the `ELATO-DEVICE` Wi-Fi network.
3. Open `http://192.168.4.1/wifi` and save your 2.4 GHz Wi-Fi credentials.
4. Follow the [ElatoAI quick start](https://www.elatoai.com/docs/quickstart) to
   register the device and select an agent.
5. Watch the Cardputer display for `READY`, `LISTENING`, `THINKING`, and
   `SPEAKING` state changes.

Hold the G0 button to enter deep sleep. Press G0 again to wake the device.

If a previously stored ElatoAI account token is stale or the device is moved to
a different account, hold **Fn + Backspace** for two seconds. The Cardputer
clears only the account token, restarts, and securely requests a fresh token for
its registered MAC address. Saved Wi-Fi networks are preserved.

## Voice server configuration

The defaults in `src/Config.h` use `ELATO_MODE` and ElatoAI's hosted voice
server. For a local or self-hosted deployment, select `DEV_MODE` or
`PROD_MODE`, choose the Deno or Cloudflare voice backend, and update the server
values and certificates in `src/Config.cpp`.

Do not commit private Wi-Fi credentials, account tokens, or production private
keys. Wi-Fi credentials and the ElatoAI device token are stored in the ESP32's
non-volatile storage at runtime.

## Hardware implementation notes

- Cardputer flash is limited to 8 MB. The supplied partition table allocates
  two 2 MB OTA application slots plus a 3 MB SPIFFS partition and fits within
  that limit.
- The microphone is read in 320-sample (20 ms) frames at 16 kHz.
- The server's Opus response is decoded to mono signed 16-bit PCM at 48 kHz.
- The standard Cardputer's PDM microphone and I2S speaker share GPIO 43. The
  Cardputer-Adv also requires codec-aware switching. Both are handled through
  M5Cardputer/M5Unified rather than hard-coded peripheral drivers.
- The generic `esp32-s3-devkitc-1` environment retains the original external
  microphone, DAC/amplifier, RGB LED, touch sensor, and button behavior.
- Cardputer speaker blocks use bounded queue waits, and completed responses
  drain buffered PCM before the microphone is restarted. This prevents a slow
  speaker queue from back-pressuring the websocket or clipping sentence ends.
- The Cardputer target builds libopus with stack-based scratch arrays and gives
  the websocket/decoder task a dedicated 32 KiB stack. This avoids libopus's
  unchecked late 120 KB pseudo-stack allocation on this no-PSRAM board.
- If a hosted response stops making progress without a completion event, a
  45-second inactivity watchdog restarts the session while preserving Wi-Fi
  and account settings. Long responses that continue streaming are unaffected.
- The LCD redraws only when the device state changes, eliminating the visible
  once-per-second flicker while preserving live listening/thinking/speaking
  status transitions.

For the upstream firmware architecture, see the
[Elato firmware documentation](https://www.elatoai.com/docs/blog/firmware).

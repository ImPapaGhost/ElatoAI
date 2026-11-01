#include "CardputerSetup.h"

#if defined(ELATO_CARDPUTER)
#include "WifiManager.h"
#include <M5Cardputer.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_wifi.h>

namespace {
CardputerProviderConfig providerConfig;
uint64_t previousKeys = 0;

bool identifier(const String &value, size_t minimum, size_t maximum) {
  if (value.length() < minimum || value.length() > maximum) return false;
  for (size_t i = 0; i < value.length(); ++i) {
    const char c = value[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.')) return false;
  }
  return true;
}

bool validProvider(const CardputerProviderConfig &value) {
  if (value.provider != "gemini" && value.provider != "elevenlabs" && value.provider != "hume") return false;
  if (!identifier(value.apiKey, 16, 256)) return false;
  if (!identifier(value.voice, 1, 48)) return false;
  if (!value.referenceId.isEmpty() && !identifier(value.referenceId, 1, 128)) return false;
  return value.provider == "gemini" || identifier(value.referenceId, 1, 128);
}

struct KeyEvent {
  bool enter = false;
  bool backspace = false;
  bool tab = false;
  bool escape = false;
  bool up = false;
  bool down = false;
  bool clear = false;
  String text;
};

uint64_t keyboardMask() {
  uint64_t mask = 0;
  for (const auto &position : M5Cardputer.Keyboard.keyList()) {
    if (position.x >= 0 && position.y >= 0 && position.x < 14 && position.y < 4)
      mask |= UINT64_C(1) << (position.y * 14 + position.x);
  }
  return mask;
}

KeyEvent readKeys() {
  M5Cardputer.update();
  KeyEvent event;
  const uint64_t current = keyboardMask();
  const uint64_t pressed = current & ~previousKeys;
  previousKeys = current;
  const auto &keys = M5Cardputer.Keyboard.keysState();
  if (!pressed) return event;
  event.escape = keys.esc;
  for (const auto &position : M5Cardputer.Keyboard.keyList()) {
    if (position.x < 0 || position.y < 0 || position.x >= 14 || position.y >= 4 ||
        !(pressed & (UINT64_C(1) << (position.y * 14 + position.x)))) continue;
    const auto key = M5Cardputer.Keyboard.getKeyValue(position);
    const uint8_t base = static_cast<uint8_t>(key.value_first);
    if (base == KEY_ENTER) event.enter = true;
    else if (base == KEY_TAB) event.tab = true;
    else if (base == KEY_BACKSPACE) { event.backspace = true; event.clear = keys.ctrl; }
    else if (base >= 32 && base <= 126 && !keys.fn) {
      const bool shifted = keys.shift || keys.ctrl || M5Cardputer.Keyboard.capslocked();
      event.text += shifted ? key.value_second : key.value_first;
    }
    if (base == ';') event.up = true;
    if (base == '.') event.down = true;
  }
  return event;
}

String shortened(const String &value, size_t count = 37) {
  return value.length() <= count ? value : value.substring(0, count - 3) + "...";
}

void line(const String &value, int y, uint16_t color = TFT_WHITE) {
  auto &display = M5Cardputer.Display;
  display.setTextColor(color, TFT_BLACK);
  display.drawString(shortened(value), 6, y);
}

void page(const String &title, const String &footer) {
  auto &display = M5Cardputer.Display;
  display.fillScreen(TFT_BLACK);
  display.setTextDatum(top_left);
  display.setTextSize(1);
  display.setTextWrap(false);
  display.fillRect(0, 0, display.width(), 22, TFT_DARKCYAN);
  display.setTextColor(TFT_WHITE, TFT_DARKCYAN);
  display.drawString(shortened(title), 6, 7);
  line(footer, 122, TFT_LIGHTGREY);
}

void notice(const String &title, const String &message) {
  page(title, "Enter: continue   Esc: back");
  line(message, 42, TFT_YELLOW);
  while (true) {
    const KeyEvent event = readKeys();
    if (event.enter || event.escape) return;
    delay(15);
  }
}

bool editField(const String &title, const String &label, String &value,
               size_t maximum, bool secret, bool required, bool restricted = false) {
  bool redraw = true;
  String error;
  while (true) {
    if (redraw) {
      page(title, "Enter: next   Esc: back");
      line(label, 32, TFT_CYAN);
      String displayed;
      if (secret) {
        for (size_t i = 0; i < min(value.length(), size_t{30}); ++i) displayed += '*';
      } else displayed = value.length() > 35 ? value.substring(value.length() - 35) : value;
      line(displayed + "_", 54);
      line(String(value.length()) + "/" + String(maximum) + " chars  Ctrl+Bksp: clear", 75, TFT_LIGHTGREY);
      line(error, 96, TFT_YELLOW);
      redraw = false;
    }
    const KeyEvent event = readKeys();
    if (event.escape) return false;
    if (event.backspace) {
      if (event.clear) value = "";
      else if (value.length()) value.remove(value.length() - 1);
      error = "";
      redraw = true;
    }
    for (size_t i = 0; i < event.text.length(); ++i) {
      const char c = event.text[i];
      if (value.length() < maximum && (!restricted || identifier(String(c), 1, 1))) value += c;
      else error = restricted ? "Use letters, digits, dot, - or _" : "Field is full";
      redraw = true;
    }
    if (event.enter) {
      if (!required || value.length()) return true;
      error = "This field is required";
      redraw = true;
    }
    delay(15);
  }
}

void stopSetupScan() {
  if (WiFi.scanComplete() == WIFI_SCAN_RUNNING) esp_wifi_scan_stop();
  WiFi.scanDelete();
}

bool setupWifi(WIFIMANAGER &manager) {
  struct Network { String ssid; int32_t rssi = -127; bool secured = true; };
  Network networks[16];
  uint8_t count = 0;
  uint8_t selected = 0;
  bool manual = false;
  bool rescan = true;
  while (true) {
    if (rescan) {
      count = 0;
      selected = 0;
      page("Wi-Fi setup", "Tab: manual SSID   Esc: browser");
      line("Searching for 2.4 GHz networks...", 43);
      WiFi.mode(WIFI_STA);
      WiFi.scanNetworks(true, false);
      const unsigned long started = millis();
      int16_t result = WIFI_SCAN_RUNNING;
      while (millis() - started < 10000) {
        const KeyEvent event = readKeys();
        if (event.escape) { stopSetupScan(); return false; }
        if (event.tab) { manual = true; break; }
        result = WiFi.scanComplete();
        if (result != WIFI_SCAN_RUNNING) break;
        delay(20);
      }
      if (!manual && result >= 0) {
        for (int16_t i = 0; i < min(result, int16_t{64}) && count < 16; ++i) {
          String ssid;
          uint8_t encryption;
          int32_t rssi;
          uint8_t *bssid;
          int32_t channel;
          if (!WiFi.getNetworkInfo(i, ssid, encryption, rssi, bssid, channel) || ssid.isEmpty()) continue;
          bool duplicate = false;
          for (uint8_t n = 0; n < count; ++n) if (networks[n].ssid == ssid) duplicate = true;
          if (!duplicate) networks[count++] = {ssid, rssi, encryption != WIFI_AUTH_OPEN};
        }
      }
      stopSetupScan();
      rescan = false;
    }

    bool redraw = true;
    while (!manual) {
      if (redraw) {
        page("Wi-Fi: choose your network", "Tab: manual   R: scan   Esc: browser");
        if (!count) line("No networks found. Press Tab.", 43, TFT_YELLOW);
        const uint8_t first = (selected / 4) * 4;
        for (uint8_t n = first; n < min(count, static_cast<uint8_t>(first + 4)); ++n) {
          line(String(n == selected ? "> " : "  ") + networks[n].ssid, 33 + (n - first) * 18,
               n == selected ? TFT_CYAN : TFT_WHITE);
        }
        line(";/.: up/down    Enter: choose", 108, TFT_LIGHTGREY);
        redraw = false;
      }
      const KeyEvent event = readKeys();
      if (event.escape) return false;
      if (event.tab) { manual = true; break; }
      if (event.text == "r" || event.text == "R") { rescan = true; break; }
      if (count && event.up) { selected = (selected + count - 1) % count; redraw = true; }
      if (count && event.down) { selected = (selected + 1) % count; redraw = true; }
      if (count && event.enter) break;
      delay(15);
    }
    if (rescan) continue;

    String ssid = manual ? String() : networks[selected].ssid;
    if (manual && !editField("Wi-Fi setup", "Network name (SSID)", ssid, 32, false, true)) {
      manual = false;
      continue;
    }
    String password;
    const bool needsPassword = manual || networks[selected].secured;
    if (needsPassword && !editField("Wi-Fi setup", "Password (blank for open network)", password, 63, true, false)) {
      manual = false;
      continue;
    }
    page("Wi-Fi setup", "Testing before saving (up to 15 sec)");
    line("Connecting to:", 36, TFT_CYAN);
    line(ssid, 56);
    line("Existing saved networks are kept.", 88, TFT_LIGHTGREY);
    String error;
    const bool connected = manager.connectAndSaveForSetup(ssid, password, error);
    password = "";
    if (connected) {
      page("Wi-Fi connected", "Continuing setup...");
      line(ssid, 42, TFT_GREEN);
      line(WiFi.localIP().toString(), 66);
      delay(900);
      return true;
    }
    notice("Wi-Fi was not changed", error);
    manual = false;
  }
}

bool setupProvider() {
  const char *ids[] = {"gemini", "elevenlabs", "hume"};
  const char *names[] = {"Gemini", "ElevenLabs", "Hume"};
  uint8_t selected = 0;
  for (uint8_t n = 0; n < 3; ++n) if (providerConfig.provider == ids[n]) selected = n;
  bool redraw = true;
  while (true) {
    if (redraw) {
      page("Choose your voice provider", ";/.: up/down   Enter: choose   Esc: skip");
      for (uint8_t n = 0; n < 3; ++n) line(String(n == selected ? "> " : "  ") + names[n], 38 + n * 23,
                                          n == selected ? TFT_CYAN : TFT_WHITE);
      redraw = false;
    }
    const KeyEvent event = readKeys();
    if (event.escape) return false;
    if (event.up) { selected = (selected + 2) % 3; redraw = true; }
    if (event.down) { selected = (selected + 1) % 3; redraw = true; }
    if (!event.enter) { delay(15); continue; }

    CardputerProviderConfig draft = providerConfig;
    if (draft.provider != ids[selected]) { draft.apiKey = ""; draft.referenceId = ""; }
    draft.provider = ids[selected];
    if (!editField(names[selected], "API key (always hidden)", draft.apiKey, 256, true, true, true)) { redraw = true; continue; }
    if (!identifier(draft.apiKey, 16, 256)) { notice("API key not saved", "Key needs 16 to 256 characters"); redraw = true; continue; }
    if (draft.provider == "gemini") draft.referenceId = "";
    else if (!editField(names[selected], draft.provider == "elevenlabs" ? "Your ElevenLabs Agent ID" : "Your Hume Config ID",
                        draft.referenceId, 128, false, true, true)) { redraw = true; continue; }

    JsonDocument document;
    document["provider"] = draft.provider;
    document["key"] = draft.apiKey;
    document["reference"] = draft.referenceId;
    document["voice"] = draft.voice;
    String encoded;
    serializeJson(document, encoded);
    Preferences saved;
    bool stored = saved.begin("cvprovider", false);
    if (stored) { stored = saved.putString("config", encoded) == encoded.length(); saved.end(); }
    encoded = "";
    if (!stored) { draft.apiKey = ""; notice("Provider not saved", "Could not write device settings"); redraw = true; continue; }
    providerConfig = draft;
    draft.apiKey = "";
    page("Provider saved", "Starting your voice connection...");
    line(names[selected], 42, TFT_GREEN);
    line("API key is stored on this device.", 68, TFT_LIGHTGREY);
    delay(900);
    return true;
  }
}
} // namespace

void loadCardputerProviderConfig() {
  providerConfig = CardputerProviderConfig{};
  Preferences saved;
  if (!saved.begin("cvprovider", true)) return;
  String encoded = saved.getString("config", "");
  saved.end();
  JsonDocument document;
  if (deserializeJson(document, encoded)) { encoded = ""; return; }
  encoded = "";
  CardputerProviderConfig candidate;
  candidate.provider = document["provider"] | "gemini";
  candidate.apiKey = document["key"] | "";
  candidate.referenceId = document["reference"] | "";
  candidate.voice = document["voice"] | "Aoede";
  if (validProvider(candidate) && identifier(candidate.voice, 1, 48)) providerConfig = candidate;
  candidate.apiKey = "";
}

const CardputerProviderConfig &getCardputerProviderConfig() { return providerConfig; }
bool cardputerProviderConfigured() { return validProvider(providerConfig); }

bool consumeCardputerSetupRequest() {
  Preferences saved;
  if (!saved.begin("cvsetup", false)) return false;
  const bool requested = saved.getBool("run", false);
  saved.remove("run");
  saved.end();
  return requested;
}

void requestCardputerSetupOnNextBoot() {
  Preferences saved;
  if (!saved.begin("cvsetup", false)) return;
  saved.putBool("run", true);
  saved.end();
}

void runCardputerBootSetup(WIFIMANAGER &manager, bool force) {
  bool needsProvider = false;
#if defined(EASY_SETUP_MODE)
  needsProvider = force || !cardputerProviderConfigured();
#endif
  bool needsWifi = !manager.configAvailable();
  if (!force && !needsWifi && !needsProvider) return;
  M5Cardputer.update();
  previousKeys = keyboardMask();
  if (force && manager.configAvailable()) {
    page("Wi-Fi is already saved", "Enter: keep Wi-Fi   Tab: change   Esc: exit");
    line("Keep your existing Wi-Fi settings?", 43, TFT_CYAN);
    line("No password needs to be retyped.", 69);
    while (true) {
      const KeyEvent event = readKeys();
      if (event.escape) return;
      if (event.enter) break;
      if (event.tab) { needsWifi = true; break; }
      delay(15);
    }
  }
  if (needsWifi && !setupWifi(manager)) {
    page("Browser Wi-Fi setup", "Booting the setup hotspot...");
#if defined(INDEPENDENT_MODE) || defined(EASY_SETUP_MODE)
    line("Join CARDPUTER-SETUP", 42, TFT_CYAN);
#else
    line("Join ELATO-DEVICE", 42, TFT_CYAN);
#endif
    line("Open http://192.168.4.1/wifi", 67);
    line("Fn+W later: on-device setup", 93, TFT_LIGHTGREY);
    delay(1600);
    return;
  }
#if defined(EASY_SETUP_MODE)
  if (needsProvider && !setupProvider() && !cardputerProviderConfigured()) {
    page("Provider not configured", "Fn+W: return to setup after boot");
    line("No provider API key was saved.", 42, TFT_YELLOW);
    line("Voice is disabled until setup.", 66);
    delay(1800);
  }
#endif
}
#endif

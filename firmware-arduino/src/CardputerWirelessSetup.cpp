#include "CardputerWirelessSetup.h"

#if defined(ELATO_CARDPUTER) && defined(CARDPUTER_WIRELESS_SETUP)
#include "Config.h"
#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <ESPAsyncWebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <atomic>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <mbedtls/base64.h>
#include <mbedtls/gcm.h>
#include <mbedtls/platform_util.h>
#include <mbedtls/sha256.h>

namespace {
constexpr uint16_t PORT = 8080;
constexpr size_t PLAIN_LIMIT = 1024;
constexpr char REQUEST_LABEL[] = "CardputerVoice wireless request v1";
constexpr char RESPONSE_LABEL[] = "CardputerVoice wireless response v1";
AsyncWebServer setupServer(PORT);
SemaphoreHandle_t stateMutex = nullptr;
QueueHandle_t commandQueue = nullptr;
std::atomic<bool> setupActive{false};
std::atomic<bool> reopenRequested{false};
std::atomic<unsigned long> reopenRequestedAt{0};
bool initialised = false;
bool cryptoTested = false;
bool cryptoReady = false;
bool mdnsStarted = false;
bool paired = false;
uint8_t controlSecret[32] = {};
char deviceId[13] = {};
char mdnsName[32] = {};
char currentChallenge[23] = {};
unsigned long challengeStarted = 0;
bool challengeLive = false;
unsigned long rateStarted = 0;
uint16_t challengeCount = 0;
uint16_t commandCount = 0;
char lastOperation[25] = {};
char lastType[16] = {};
char lastCode[40] = {};

class StateLock {
public:
  explicit StateLock(TickType_t wait = pdMS_TO_TICKS(100))
    : held(stateMutex != nullptr && xSemaphoreTake(stateMutex, wait) == pdTRUE) {}
  ~StateLock() { if (held) xSemaphoreGive(stateMutex); }
  explicit operator bool() const { return held; }
private:
  bool held;
};

bool hexId(const String &value, size_t length, bool uppercase = false) {
  if (value.length() != length) return false;
  for (size_t n = 0; n < length; ++n) {
    const char c = value[n];
    if (!((c >= '0' && c <= '9') || (uppercase ? (c >= 'A' && c <= 'F') : (c >= 'a' && c <= 'f')))) return false;
  }
  return true;
}

String base64url(const uint8_t *data, size_t length) {
  if (length > 512) return String();
  unsigned char encoded[685] = {};
  size_t written = 0;
  if (mbedtls_base64_encode(encoded, sizeof(encoded), &written, data, length) != 0) return String();
  encoded[written] = 0;
  String result(reinterpret_cast<char *>(encoded));
  result.replace('+', '-');
  result.replace('/', '_');
  while (result.endsWith("=")) result.remove(result.length() - 1);
  return result;
}

bool decode64(const String &encoded, uint8_t *out, size_t capacity, size_t &length) {
  if (encoded.isEmpty() || encoded.length() > 1390 || encoded.length() % 4 == 1) return false;
  for (size_t n = 0; n < encoded.length(); ++n) {
    const char c = encoded[n];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  String standard = encoded;
  standard.replace('-', '+');
  standard.replace('_', '/');
  while (standard.length() % 4) standard += '=';
  return mbedtls_base64_decode(out, capacity, &length,
           reinterpret_cast<const uint8_t *>(standard.c_str()), standard.length()) == 0;
}

bool derive(const uint8_t *secret, const char *label, uint8_t *key) {
  uint8_t material[96] = {};
  const size_t length = strlen(label);
  if (length > sizeof(material) - 32) return false;
  memcpy(material, secret, 32);
  memcpy(material + 32, label, length);
  const bool ok = mbedtls_sha256_ret(material, 32 + length, key, 0) == 0;
  mbedtls_platform_zeroize(material, sizeof(material));
  return ok;
}

bool cryptoKnownAnswerTest() {
  // Public Node WebCrypto fixture from wireless-setup.test.mjs. This local
  // synthetic secret is never read from or written to the pairing secret.
  constexpr uint8_t expectedRequestKey[32] = {
    0x6b, 0xdb, 0xde, 0x33, 0xbe, 0x74, 0xdb, 0x08, 0x98, 0x3d, 0x2f, 0xa1, 0xe0, 0x2c, 0xdb, 0x54,
    0x76, 0x53, 0x4e, 0xc3, 0xeb, 0x5c, 0x3a, 0x19, 0x4a, 0xf8, 0xb8, 0x22, 0x27, 0xdc, 0x77, 0x58
  };
  constexpr uint8_t expectedResponseKey[32] = {
    0x05, 0x97, 0x36, 0xa7, 0x89, 0xaf, 0x18, 0x71, 0x49, 0xa3, 0xa0, 0x38, 0x08, 0x84, 0x62, 0x58,
    0xa1, 0x6d, 0x9a, 0x34, 0x2e, 0x34, 0xba, 0x79, 0x33, 0x9c, 0xbe, 0x81, 0x52, 0xe5, 0xa0, 0x0f
  };
  constexpr char plaintext[] = "{\"type\":\"open_setup\"}";
  constexpr char aad[] = "CVWIFI1|request|001122AABBCC|EBESExQVFhcYGRobHB0eHw|00112233445566778899aabb";
  constexpr char expectedCiphertext[] = "HXKU8mQ8gB-_NXWAYZV2_c2uKK-SpufJOhtkJfy-sxGvH5jBTw";
  constexpr size_t textLength = sizeof(plaintext) - 1;
  uint8_t secret[32];
  uint8_t requestKey[32] = {};
  uint8_t responseKey[32] = {};
  uint8_t iv[12];
  uint8_t ciphertext[textLength + 16] = {};
  uint8_t decrypted[textLength] = {};
  for (size_t n = 0; n < sizeof(secret); ++n) secret[n] = static_cast<uint8_t>(n);
  for (size_t n = 0; n < sizeof(iv); ++n) iv[n] = static_cast<uint8_t>(0x20 + n);
  bool ok = derive(secret, REQUEST_LABEL, requestKey) && derive(secret, RESPONSE_LABEL, responseKey) &&
    memcmp(requestKey, expectedRequestKey, sizeof(requestKey)) == 0 &&
    memcmp(responseKey, expectedResponseKey, sizeof(responseKey)) == 0;
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  int result = ok ? mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, requestKey, 256) : -1;
  if (result == 0) result = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT,
    textLength, iv, sizeof(iv), reinterpret_cast<const uint8_t *>(aad), sizeof(aad) - 1,
    reinterpret_cast<const uint8_t *>(plaintext), ciphertext, 16, ciphertext + textLength);
  ok = result == 0 && base64url(ciphertext, sizeof(ciphertext)) == expectedCiphertext;
  if (ok) {
    result = mbedtls_gcm_auth_decrypt(&gcm, textLength, iv, sizeof(iv),
      reinterpret_cast<const uint8_t *>(aad), sizeof(aad) - 1,
      ciphertext + textLength, 16, ciphertext, decrypted);
    ok = result == 0 && memcmp(decrypted, plaintext, textLength) == 0;
  }
  mbedtls_gcm_free(&gcm);
  mbedtls_platform_zeroize(secret, sizeof(secret));
  mbedtls_platform_zeroize(requestKey, sizeof(requestKey));
  mbedtls_platform_zeroize(responseKey, sizeof(responseKey));
  mbedtls_platform_zeroize(ciphertext, sizeof(ciphertext));
  mbedtls_platform_zeroize(decrypted, sizeof(decrypted));
  return ok;
}

String origin() { return String("https://") + CARDPUTER_SERVER_HOST; }

bool allowedOrigin(AsyncWebServerRequest *request) {
  return request->hasHeader("Origin") && request->getHeader("Origin")->value() == origin();
}

void sendJson(AsyncWebServerRequest *request, int status, const String &json) {
  AsyncWebServerResponse *response = request->beginResponse(status, "application/json", json);
  response->addHeader("Cache-Control", "no-store");
  response->addHeader("X-Content-Type-Options", "nosniff");
  if (allowedOrigin(request)) {
    response->addHeader("Access-Control-Allow-Origin", origin());
    response->addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response->addHeader("Access-Control-Allow-Headers", "Content-Type");
    response->addHeader("Access-Control-Allow-Private-Network", "true");
    response->addHeader("Vary", "Origin");
  }
  request->send(response);
}

void error(AsyncWebServerRequest *request, int status) {
  sendJson(request, status, "{\"error\":\"wireless_setup_unavailable\"}");
}

bool rateAllowed(bool challenge) {
  if (millis() - rateStarted >= 60000) {
    rateStarted = millis();
    challengeCount = 0;
    commandCount = 0;
  }
  uint16_t &count = challenge ? challengeCount : commandCount;
  if (count >= 60) return false;
  ++count;
  return true;
}

void setOperation(const char *id, const char *type, const char *code = nullptr) {
  strlcpy(lastOperation, id, sizeof(lastOperation));
  strlcpy(lastType, type, sizeof(lastType));
  strlcpy(lastCode, code == nullptr ? "" : code, sizeof(lastCode));
}

bool encryptReply(const uint8_t *key, const String &id, const String &challenge,
                  JsonDocument &plain, String &encoded) {
  String text;
  serializeJson(plain, text);
  if (text.length() > 480) return false;
  uint8_t iv[12];
  uint8_t ciphertext[496];
  esp_fill_random(iv, sizeof(iv));
  const String aad = String("CVWIFI1|response|") + deviceId + "|" + challenge + "|" + id;
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  int result = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, 256);
  if (result == 0) result = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT,
    text.length(), iv, sizeof(iv), reinterpret_cast<const uint8_t *>(aad.c_str()), aad.length(),
    reinterpret_cast<const uint8_t *>(text.c_str()), ciphertext, 16, ciphertext + text.length());
  mbedtls_gcm_free(&gcm);
  if (result != 0) return false;
  JsonDocument envelope;
  envelope["protocol"] = 1;
  envelope["deviceId"] = deviceId;
  envelope["id"] = id;
  envelope["challenge"] = challenge;
  envelope["iv"] = base64url(iv, sizeof(iv));
  envelope["ciphertext"] = base64url(ciphertext, text.length() + 16);
  serializeJson(envelope, encoded);
  mbedtls_platform_zeroize(ciphertext, sizeof(ciphertext));
  return true;
}

void handleCommand(AsyncWebServerRequest *request, JsonVariant &envelope) {
  if (!allowedOrigin(request) || WiFi.status() != WL_CONNECTED) { error(request, 403); return; }
  if (!envelope["protocol"].is<int>() || envelope["protocol"].as<int>() != 1 ||
      !envelope["deviceId"].is<String>() || !envelope["id"].is<String>() ||
      !envelope["challenge"].is<String>() || !envelope["iv"].is<String>() || !envelope["ciphertext"].is<String>()) {
    error(request, 400); return;
  }
  const String id = envelope["id"].as<String>();
  const String challenge = envelope["challenge"].as<String>();
  const String requestedDevice = envelope["deviceId"].as<String>();
  if (!hexId(id, 24) || !hexId(requestedDevice, 12, true) || challenge.length() != 22) { error(request, 400); return; }
  uint8_t iv[12];
  uint8_t cipher[1040];
  uint8_t plaintext[1025] = {};
  uint8_t requestKey[32] = {};
  uint8_t responseKey[32] = {};
  size_t ivLength = 0;
  size_t cipherLength = 0;
  if (!decode64(envelope["iv"].as<String>(), iv, sizeof(iv), ivLength) || ivLength != sizeof(iv) ||
      !decode64(envelope["ciphertext"].as<String>(), cipher, sizeof(cipher), cipherLength) || cipherLength < 17) {
    error(request, 400); return;
  }

  JsonDocument reply;
  reply["id"] = id;
  String encrypted;
  {
    StateLock lock;
    if (!lock) { error(request, 503); return; }
    if (!rateAllowed(false)) { error(request, 429); return; }
    if (!paired || requestedDevice != deviceId || !challengeLive || challenge != currentChallenge ||
        millis() - challengeStarted >= 15000) { error(request, 401); return; }
    if (!derive(controlSecret, REQUEST_LABEL, requestKey) || !derive(controlSecret, RESPONSE_LABEL, responseKey)) { error(request, 503); return; }
    const String aad = String("CVWIFI1|request|") + deviceId + "|" + challenge + "|" + id;
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int result = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, requestKey, 256);
    if (result == 0) result = mbedtls_gcm_auth_decrypt(&gcm, cipherLength - 16,
      iv, sizeof(iv), reinterpret_cast<const uint8_t *>(aad.c_str()), aad.length(),
      cipher + cipherLength - 16, 16, cipher, plaintext);
    mbedtls_gcm_free(&gcm);
    mbedtls_platform_zeroize(requestKey, sizeof(requestKey));
    if (result != 0) {
      mbedtls_platform_zeroize(responseKey, sizeof(responseKey));
      mbedtls_platform_zeroize(plaintext, sizeof(plaintext));
      error(request, 401); return;
    }
    // Consume only an authenticated challenge, BEFORE executing any command,
    // including a busy/invalid command. The mutex prevents replay races.
    challengeLive = false;
    JsonDocument command;
    // Read-only input makes ArduinoJson own its strings before the plaintext
    // scratch buffer is wiped (mutable input would enable zero-copy pointers).
    const bool parsed = !deserializeJson(command, static_cast<const uint8_t *>(plaintext), cipherLength - 16);
    mbedtls_platform_zeroize(plaintext, sizeof(plaintext));
    const String type = parsed ? command["type"].as<String>() : String();
    if (type == "status") {
      const String operation = command["operationId"] | "";
      reply["operationId"] = operation;
      if (!hexId(operation, 24) || operation != lastOperation) {
        reply["type"] = "error"; reply["code"] = "unknown_operation";
      } else {
        reply["type"] = lastType;
        if (lastCode[0]) reply["code"] = lastCode;
      }
    } else if (type == "open_setup") {
      if (setupActive.load()) reply["type"] = "setup_open";
      else {
        Preferences saved;
        bool stored = saved.begin("cvsetup", false);
        if (stored) { stored = saved.putBool("run", true) > 0 && saved.getBool("run", false); saved.end(); }
        if (stored) {
          reopenRequestedAt.store(millis());
          reopenRequested.store(true);
          reply["type"] = "restarting";
        }
        else { reply["type"] = "error"; reply["code"] = "save_failed"; }
      }
    } else if (type == "configure") {
      reply["operationId"] = id;
      if (!setupActive.load()) { reply["type"] = "error"; reply["code"] = "not_in_setup"; }
      else if (strcmp(lastType, "pending") == 0) { reply["type"] = "error"; reply["code"] = "busy"; }
      else {
        command["id"] = id;
        if (measureJson(command) > PLAIN_LIMIT) { reply["type"] = "error"; reply["code"] = "invalid_config"; }
        else {
          CardputerWirelessRequest queued;
          strlcpy(queued.operationId, id.c_str(), sizeof(queued.operationId));
          queued.acceptedMillis = millis();
          serializeJson(command, queued.json, sizeof(queued.json));
          if (xQueueSend(commandQueue, &queued, 0) != pdTRUE) { reply["type"] = "error"; reply["code"] = "busy"; }
          else { setOperation(id.c_str(), "pending"); reply["type"] = "pending"; }
          mbedtls_platform_zeroize(&queued, sizeof(queued));
        }
      }
    } else { reply["type"] = "error"; reply["code"] = "invalid_config"; }
    command.clear();
    if (!encryptReply(responseKey, id, challenge, reply, encrypted)) encrypted = "";
    mbedtls_platform_zeroize(responseKey, sizeof(responseKey));
  }
  mbedtls_platform_zeroize(cipher, sizeof(cipher));
  if (encrypted.isEmpty()) { error(request, 503); return; }
  sendJson(request, 200, encrypted);
}
} // namespace

void initialiseCardputerWirelessSetup() {
  if (initialised) return;
  if (!cryptoTested) {
    cryptoTested = true;
    cryptoReady = cryptoKnownAnswerTest();
  }
  if (!cryptoReady) return;
  stateMutex = xSemaphoreCreateMutex();
  commandQueue = xQueueCreate(1, sizeof(CardputerWirelessRequest));
  if (stateMutex == nullptr || commandQueue == nullptr) return;
  // STA radio is enabled before using its RF-assisted hardware entropy source.
  if (!WiFi.mode(WIFI_STA)) return;
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  mac.toUpperCase();
  if (!hexId(mac, 12, true)) return;
  strlcpy(deviceId, mac.c_str(), sizeof(deviceId));
  String name = String("cardputer-") + mac.substring(6);
  name.toLowerCase();
  strlcpy(mdnsName, name.c_str(), sizeof(mdnsName));
  Preferences saved;
  if (saved.begin("cvwireless", true)) {
    paired = saved.getBytesLength("secret") == sizeof(controlSecret) &&
      saved.getBytes("secret", controlSecret, sizeof(controlSecret)) == sizeof(controlSecret);
    saved.end();
  }
  setupServer.on("/setup/challenge", HTTP_OPTIONS, [](AsyncWebServerRequest *request) {
    if (!allowedOrigin(request)) { error(request, 403); return; }
    sendJson(request, 204, "");
  });
  setupServer.on("/setup/command", HTTP_OPTIONS, [](AsyncWebServerRequest *request) {
    if (!allowedOrigin(request)) { error(request, 403); return; }
    sendJson(request, 204, "");
  });
  setupServer.on("/setup/challenge", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (!allowedOrigin(request) || WiFi.status() != WL_CONNECTED) { error(request, 403); return; }
    StateLock lock;
    if (!lock) { error(request, 503); return; }
    if (!paired) { error(request, 401); return; }
    if (!rateAllowed(true)) { error(request, 429); return; }
    uint8_t random[16];
    esp_fill_random(random, sizeof(random));
    const String challenge = base64url(random, sizeof(random));
    strlcpy(currentChallenge, challenge.c_str(), sizeof(currentChallenge));
    challengeStarted = millis();
    challengeLive = true;
    JsonDocument reply;
    reply["protocol"] = 1;
    reply["deviceId"] = deviceId;
    reply["challenge"] = challenge;
    reply["expiresIn"] = 15;
    String json;
    serializeJson(reply, json);
    sendJson(request, 200, json);
  });
  auto *handler = new AsyncCallbackJsonWebHandler("/setup/command", handleCommand);
  handler->setMethod(HTTP_POST);
  handler->setMaxContentLength(1536);
  setupServer.addHandler(handler);
  setupServer.onNotFound([](AsyncWebServerRequest *request) { error(request, 404); });
  setupServer.begin();
  initialised = true;
}

bool cardputerWirelessCryptoReady() { return cryptoReady; }

void pollCardputerWirelessSetup() {
  if (!initialised) return;
  if (WiFi.status() == WL_CONNECTED && !mdnsStarted) {
    mdnsStarted = MDNS.begin(mdnsName);
    if (mdnsStarted) MDNS.addService("http", "tcp", PORT);
  } else if (WiFi.status() != WL_CONNECTED && mdnsStarted) {
    MDNS.end();
    mdnsStarted = false;
  }
}

void setCardputerWirelessSetupActive(bool active) {
  // This UI-side transition shares the command acceptance lock. No callback
  // can enqueue a request between the final boot UI poll and its teardown.
  StateLock lock(portMAX_DELAY);
  if (!lock) { setupActive.store(false); return; }
  setupActive.store(active);
  if (!active && commandQueue != nullptr) {
    CardputerWirelessRequest discarded;
    while (xQueueReceive(commandQueue, &discarded, 0) == pdTRUE) {
      mbedtls_platform_zeroize(&discarded, sizeof(discarded));
    }
    if (strcmp(lastType, "pending") == 0) {
      strlcpy(lastType, "cancelled", sizeof(lastType));
      lastCode[0] = 0;
    }
  }
}
bool consumeCardputerWirelessReopenRequest() {
  // Give the encrypted HTTP acknowledgement time to leave AsyncTCP before the
  // LED task performs its existing graceful disconnect/restart sequence.
  if (!reopenRequested.load() || millis() - reopenRequestedAt.load() < 1000) return false;
  return reopenRequested.exchange(false);
}

bool takeCardputerWirelessSetupRequest(CardputerWirelessRequest &request) {
  return commandQueue != nullptr && xQueueReceive(commandQueue, &request, 0) == pdTRUE;
}

void publishCardputerWirelessSetupResult(const char *operationId, const char *type, const char *code) {
  if (operationId == nullptr || type == nullptr || !hexId(String(operationId), 24)) return;
  if (strcmp(type, "pending") != 0 && strcmp(type, "saved") != 0 && strcmp(type, "cancelled") != 0 && strcmp(type, "error") != 0) return;
  StateLock lock;
  if (!lock || strcmp(operationId, lastOperation) != 0) return;
  setOperation(operationId, type, code);
}

bool pairCardputerWirelessSetup(CardputerWirelessPairing &pairing) {
  if (!initialised || !setupActive.load()) return false;
  uint8_t generated[32];
  uint8_t readback[32] = {};
  // This function is reached only after the UI has consumed a fresh physical
  // Enter for USB pair_wireless. The STA radio is already active for entropy.
  const wifi_mode_t mode = WiFi.getMode();
  if (!(mode & WIFI_MODE_STA) && !WiFi.mode(mode == WIFI_MODE_AP ? WIFI_AP_STA : WIFI_STA)) return false;
  esp_fill_random(generated, sizeof(generated));
  StateLock lock;
  if (!lock) { mbedtls_platform_zeroize(generated, sizeof(generated)); return false; }
  Preferences saved;
  bool stored = saved.begin("cvwireless", false);
  if (stored) {
    stored = saved.putBytes("secret", generated, sizeof(generated)) == sizeof(generated) &&
      saved.getBytes("secret", readback, sizeof(readback)) == sizeof(readback) &&
      memcmp(generated, readback, sizeof(generated)) == 0;
    saved.end();
  }
  mbedtls_platform_zeroize(readback, sizeof(readback));
  if (!stored) { mbedtls_platform_zeroize(generated, sizeof(generated)); return false; }
  // Rotation revokes already authenticated work as well as the old key. The
  // acceptance mutex prevents an old browser from queuing more work here.
  CardputerWirelessRequest discarded;
  while (xQueueReceive(commandQueue, &discarded, 0) == pdTRUE) {
    mbedtls_platform_zeroize(&discarded, sizeof(discarded));
  }
  mbedtls_platform_zeroize(&discarded, sizeof(discarded));
  mbedtls_platform_zeroize(lastOperation, sizeof(lastOperation));
  mbedtls_platform_zeroize(lastType, sizeof(lastType));
  mbedtls_platform_zeroize(lastCode, sizeof(lastCode));
  memcpy(controlSecret, generated, sizeof(controlSecret));
  paired = true;
  challengeLive = false;
  pairing.deviceId = deviceId;
  pairing.host = String(mdnsName) + ".local";
  pairing.ip = WiFi.localIP().toString();
  pairing.port = PORT;
  pairing.controlSecret = base64url(generated, sizeof(generated));
  mbedtls_platform_zeroize(generated, sizeof(generated));
  return pairing.controlSecret.length() == 43;
}
#endif

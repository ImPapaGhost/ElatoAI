/**
 * Wifi Manager
 * (c) 2022-2024 Martin Verges
 *
 * Licensed under CC BY-NC-SA 4.0
 * (Attribution-NonCommercial-ShareAlike 4.0 International)
**/
#include "WifiManager.h"
#include "OTA.h"
#include "AsyncJson.h"
#include "ArduinoJson.h"
#include <WiFi.h>
#include <Preferences.h>
#include <Config.h>
#if defined(EASY_SETUP_MODE)
#include "CardputerSetup.h"
#endif

bool isDeviceRegistered() {
#if defined(EASY_SETUP_MODE)
  // BYOK devices never request an ElatoAI account token, even when setup was
  // cancelled before a provider key was entered.
  return cardputerProviderConfigured();
#else
  if (!authTokenGlobal.isEmpty()) {
    return true;
  }

    HTTPClient http;

    #ifdef DEV_MODE
      http.begin("http://" + String(backend_server) + ":" + String(backend_port) +
                  "/api/generate_auth_token?macAddress=" + WiFi.macAddress());
    #else
      WiFiClientSecure client;
      client.setCACert(Vercel_CA_cert);
      http.begin(client, "https://" + String(backend_server) +
                  "/api/generate_auth_token?macAddress=" + WiFi.macAddress());
    #endif

    http.setTimeout(10000);

    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, payload);

        if (error) {
            Serial.print("JSON parsing failed: ");
            Serial.println(error.c_str());
            http.end();
            return false;
        }

        String authToken = doc["token"];
        if (!authToken.isEmpty()) {
            // Store the auth token in NVS
            preferences.begin("auth", false);
            preferences.putString("auth_token", authToken);
            preferences.end();

            authTokenGlobal = String(authToken);
            http.end();
            return true;
        }
    }

    // If we get here, either the request failed or no token was found
    http.end();
    return false;
#endif
}

void connectCb() {
  Serial.println("On connecting to Wifi");
  if (isDeviceRegistered())  {
#if defined(INDEPENDENT_MODE)
    websocketSetup(ws_server, ws_port, ws_path);
#else
    if (otaState == OTA_IN_PROGRESS) {
        performOTAUpdate();
    } else if (otaState == OTA_COMPLETE) {
        markOTAUpdateComplete();
        ESP.restart();
    } else {
        websocketSetup(ws_server, ws_port, ws_path);
    }
#endif
  } 
}

/**
 * @brief Write a message to the Serial interface
 * @param msg The message to be written
 *
 * This function is a simple wrapper around Serial.print() to write a message
 * to the serial console. It can be overwritten by a custom implementation for 
 * enhanced logging.
 */
void WIFIMANAGER::logMessage(String msg) {
  Serial.print(msg);
}

/**
 * @brief Background Task running as a loop forever
 * @param param needs to be a valid WIFIMANAGER instance
 */
void wifiTask(void* param) {
  yield();
  delay(500); // wait a short time until everything is setup before executing the loop forever
  yield();
  const TickType_t xDelay = 10000 / portTICK_PERIOD_MS;
  WIFIMANAGER * wifimanager = (WIFIMANAGER *) param;

  for(;;) {
    yield();
    wifimanager->loop();
    yield();
    vTaskDelay(xDelay);
  }
}

/**
 * @brief Start the background task, which will take care of the Wifi connection
 *
 * This method will load the configuration from NVS, try to connect to the configured WIFI(s)
 * and then start a background task, which will keep monitoring and trying to reconnect
 * to the configured WIFI(s) in case the connection drops.
 */
void WIFIMANAGER::startBackgroundTask(String softApName, String softApPass) {
  if (softApName.length()) this->softApName = softApName;
  if (softApPass.length()) this->softApPass = softApPass;

  WiFi.setSleep(false);
  loadFromNVS();
  tryConnect();

  BaseType_t taskCreated = xTaskCreatePinnedToCore(
    wifiTask,
    "WifiManager",
    4096,   // Stack size in words
    this,   // Task input parameter
    1,      // Priority of the task
    &WifiCheckTask,  // Task handle.
    0       // Core where the task should run
  );

  if (taskCreated != pdPASS) {
    logMessage("[ERROR] WifiManager: Error creating background task\n");
  }
}

/**
 * @brief Construct a new WIFIMANAGER::WIFIMANAGER object
 * @details Puts the Wifi mode to AP+STA and registers Wifi Events
 * @param ns Namespace for the preferences non volatile storage (NVS)
 */
WIFIMANAGER::WIFIMANAGER(const char * ns) {
  NVS = (char *)ns;

  // AP on/off
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() AP mode started!\n");
    softApRunning = true;
    deviceState = SOFT_AP;
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_START); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_START); // arduino-esp32 1.0.6
#endif
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() AP mode stopped!\n");
    softApRunning = false;
    deviceState = IDLE;
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_STOP); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_STOP); // arduino-esp32 1.0.6
#endif
  // AP client join/leave
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() new client connected to softAP!\n");
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_STACONNECTED); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_STACONNECTED); // arduino-esp32 1.0.6
#endif
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() Client disconnected from softAP!\n");
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_STADISCONNECTED); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_STADISCONNECTED); // arduino-esp32 1.0.6
#endif
}

/**
 * @brief Destroy the WIFIMANAGER::WIFIMANAGER object
 * @details will stop the background task as well but not cleanup the AsyncWebserver
 */
WIFIMANAGER::~WIFIMANAGER() {
  vTaskDelete(WifiCheckTask);
  // FIXME: get rid of the registered Webserver AsyncCallbackWebHandlers
}

/**
 * @brief If no WIFI is available, fallback to create an AP on the ESP32
 * @param state boolean true (create AP) or false (don't create an AP)
 */
void WIFIMANAGER::fallbackToSoftAp(const bool state) {
  createFallbackAP = state;
}

/**
 * @brief Get the current configured fallback state
 * @return true
 * @return false
 */
bool WIFIMANAGER::getFallbackState() const {
  return createFallbackAP;
}

/**
 * @brief Remove all entries from the current known and configured Wifi list
 * @details This only affects memory, not the storage!
 * @details If you wan't to persist this, you need to call writeToNVS()
 */
void WIFIMANAGER::clearApList() {
  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    apList[i].apName = "";
    apList[i].apPass = "";
  }
}

/**
 * @brief Load last saved configuration from the NVS into the memory
 * @return true on success
 * @return false on error
 */
bool WIFIMANAGER::loadFromNVS() {
  configuredSSIDs = 0;
  clearApList();
  if (preferences.begin(NVS, true)) {
    char tmpKey[10] = { 0 };
    for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
      sprintf(tmpKey, "apName%d", i);
      if (preferences.getType(tmpKey) == PT_STR) {
        String apName = preferences.getString(tmpKey, "");
        if (apName.length() > 0) {
          sprintf(tmpKey, "apPass%d", i);
          String apPass = preferences.getString(tmpKey);
          logMessage(String("[WIFI] Load SSID '") + apName + "' to " + String(i+1) + ". slot.\n");
          apList[i].apName = apName;
          apList[i].apPass = apPass;
          configuredSSIDs++;
        }
      }
    }
    preferences.end();
    return true;
  }
  logMessage("[WIFI] Unable to load data from NVS, giving up...\n");
  return false;
}

/**
 * @brief Write the current in memory configuration to the non volatile storage
 * @return true on success
 * @return false on error with the NVS
 */
#if defined(CARDPUTER_WIRELESS_SETUP)
bool WIFIMANAGER::beginSavedNetworkForSetup() {
  if (WiFi.status() == WL_CONNECTED) return true;
  String preferred;
  Preferences hint;
  if (hint.begin("cvsetup", true)) {
    preferred = hint.getString("ssid", "");
    hint.end();
  }
  uint8_t selected = WIFIMANAGER_MAX_APS;
  for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; ++i) {
    if (apList[i].apName.isEmpty()) continue;
    if (selected == WIFIMANAGER_MAX_APS) selected = i;
    if (!preferred.isEmpty() && apList[i].apName == preferred) { selected = i; break; }
  }
  if (selected == WIFIMANAGER_MAX_APS) return false;
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(apList[selected].apName.c_str(), apList[selected].apPass.c_str());
  return true;
}
#endif

bool WIFIMANAGER::writeToNVS() {
  if (!preferences.begin(NVS, false)) {
    logMessage("[WIFI] Unable to write data to NVS, giving up...");
    return false;
  }

  preferences.clear();
  char tmpKey[10];
  for(uint8_t i = 0; i < WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName.isEmpty()) continue;

    snprintf(tmpKey, sizeof(tmpKey), "apName%d", i);
    preferences.putString(tmpKey, apList[i].apName);

    snprintf(tmpKey, sizeof(tmpKey), "apPass%d", i);
    preferences.putString(tmpKey, apList[i].apPass);
  }

  preferences.end();
  return true;
}

/**
 * @brief Add a new WIFI SSID to the known credentials list
 * @param apName Name of the SSID to connect to
 * @param apPass Password (or empty) to connect to the SSID
 * @param updateNVS Write the new entry directly to NVS
 * @return true on success
 * @return false on failure
 */
bool WIFIMANAGER::addWifi(String apName, String apPass, bool updateNVS) {
  if(apName.length() < 1 || apName.length() > 32) {
    logMessage("[WIFI] No SSID given or ssid too long");
    return false;
  }

  if(apPass.length() > 63) {
    logMessage("[WIFI] Passphrase too long");
    return false;
  }

  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName == "") {
      logMessage(String("[WIFI] Found unused slot Nr. ") + String(i) + " to store the new SSID '" + apName + "' credentials.\n");
      apList[i].apName = apName;
      apList[i].apPass = apPass;
      configuredSSIDs++;
      if (updateNVS) return writeToNVS();
      else return true;
    }
  }
  logMessage("[WIFI] No slot available to store SSID credentials");
  return false; // max entries reached
}

#if defined(ELATO_CARDPUTER)
bool WIFIMANAGER::connectAndSaveForSetup(const String &ssid, const String &password, String &error) {
  if (ssid.length() < 1 || ssid.length() > 32 || password.length() > 63) {
    error = "Check network name/password length";
    return false;
  }
  uint8_t slot = WIFIMANAGER_MAX_APS;
  for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; ++i) {
    if (apList[i].apName == ssid) { slot = i; break; }
    if (slot == WIFIMANAGER_MAX_APS && apList[i].apName.isEmpty()) slot = i;
  }
  if (slot == WIFIMANAGER_MAX_APS) {
    error = "Saved list full. Use browser setup";
    return false;
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  const unsigned long disconnectStarted = millis();
  while (WiFi.status() == WL_CONNECTED && millis() - disconnectStarted < 1500) delay(20);
  if (WiFi.status() == WL_CONNECTED) {
    error = "Wi-Fi busy. Please retry";
    return false;
  }

  // Do not accept the previous association for a same-SSID password edit.
  WiFi.begin(ssid.c_str(), password.c_str());
  const unsigned long started = millis();
  bool connected = false;
  while (millis() - started < 15000) {
    const wl_status_t status = WiFi.status();
    if (status == WL_CONNECTED && WiFi.SSID() == ssid) { connected = true; break; }
    // begin() starts association asynchronously; failure status from the last
    // attempt can remain cached briefly. Give this fresh attempt time to emit
    // its own events so correcting a password can succeed without rebooting.
    if (millis() - started >= 1500 &&
        (status == WL_CONNECT_FAILED || status == WL_NO_SSID_AVAIL)) break;
    delay(50);
  }
  if (!connected) {
    WiFi.disconnect(false, false);
    error = "Wrong password or network unavailable";
    return false;
  }
  if (!preferences.begin(NVS, false)) {
    error = "Could not save Wi-Fi settings";
    return false;
  }
  char passKey[10];
  char nameKey[10];
  snprintf(passKey, sizeof(passKey), "apPass%u", slot);
  snprintf(nameKey, sizeof(nameKey), "apName%u", slot);
  // Password first, then publish the name of a new slot. Never clear NVS or
  // overwrite another working network to make room for an unverified attempt.
  const bool passSaved = preferences.putString(passKey, password) == password.length();
  const bool nameSaved = passSaved && preferences.putString(nameKey, ssid) == ssid.length();
  // putString("") returns zero both on success and failure. Read back with a
  // nonempty sentinel so an absent open-network password cannot look saved.
  const bool verified = nameSaved &&
    preferences.getString(passKey, "\001not-written\002") == password &&
    preferences.getString(nameKey, "\001not-written\002") == ssid;
  preferences.end();
  if (!verified) {
    error = "Connected, but settings did not save";
    return false;
  }
  if (apList[slot].apName.isEmpty()) ++configuredSSIDs;
  apList[slot].apName = ssid;
  apList[slot].apPass = password;
  error = "";
  return true;
}
#endif

/**
 * @brief Drop a known SSID entry ID from the known list and write change to NVS
 * @param apId ID of the SSID within the array
 * @return true on success
 * @return false on error
 */
bool WIFIMANAGER::delWifi(uint8_t apId) {
  if (apId < WIFIMANAGER_MAX_APS) {
    apList[apId].apName.clear();
    apList[apId].apPass.clear();
    return writeToNVS();
  }
  return false;
}

/**
 * @brief Drop a known SSID name from the known list and write change to NVS
 * @param apName SSID name
 * @return true on success
 * @return false on error
 */
bool WIFIMANAGER::delWifi(String apName) {
  int num = 0;
  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName == apName) {
      if (delWifi(i)) num++;
    }
  }
  return num > 0;
}

/**
 * @brief Provides information about the current configuration state
 * @details When at least 1 SSID is configured, the return value will be true, otherwise false
 * @return true if one or more SSIDs stored
 * @return false if no configuration is available
 */
bool WIFIMANAGER::configAvailable() const {
    return configuredSSIDs != 0;
}

/**
 * @brief Provides the apList element id of the first configured slot
 * @details It's used to speed up connection by getting the first available configuration
 * @note only call this function when you have configuredSSIDs > 0, otherwise it will return 0 as well and fail!
 * @return uint8_t apList element id
 */
uint8_t WIFIMANAGER::getApEntry() {
  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName.length()) return i;
  }
  logMessage("[WIFI][ERROR] We did not find a valid entry!\n");
  logMessage("[WIFI][ERROR] Make sure to not call this function if configuredSSIDs != 1.\n");
  return 0;
}

/**
 * @brief Background loop function running inside the task
 * @details regulary check if the connection is up&running, try to reconnect or create a fallback AP
 */
void WIFIMANAGER::loop() {
  if (millis() - lastWifiCheckMillis < intervalWifiCheckMillis) return;
  lastWifiCheckMillis = millis();

  if(WiFi.waitForConnectResult() == WL_CONNECTED) {
    // Check if we are connected to a well known SSID
    for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
      if (WiFi.SSID() == apList[i].apName) {
        logMessage(String("[WIFI][STATUS] Connected to known SSID: '") + WiFi.SSID() + "' with IP " + WiFi.localIP().toString() + "\n");
        return;
      }
    }
    // looks like we are connected to something else, strange!?
    logMessage("[WIFI] We are connected to an unknown SSID ignoring. Connected to: " + WiFi.SSID() + "\n");
  } else {
    if (softApRunning) {
      logMessage("[WIFI] Not trying to connect to a known SSID. SoftAP has " + String(WiFi.softAPgetStationNum()) + " clients connected!\n");
    } else {
      // let's try to connect to some WiFi in Range
      if (!tryConnect()) {
        if (createFallbackAP) runSoftAP();
        else logMessage("[WIFI] Auto creation of SoftAP is disabled, no starting AP!\n");
      }
    }
  }

  if (softApRunning && millis() - startApTimeMillis > timeoutApMillis) {
    if (WiFi.softAPgetStationNum() > 0) {
      logMessage("[WIFI] SoftAP has " + String(WiFi.softAPgetStationNum()) + " clients connected!\n");
      startApTimeMillis = millis(); // reset timeout as someone is connected
      return;
    }
    logMessage("[WIFI] Running in AP mode but timeout reached. Closing AP!\n");
    stopSoftAP();
    delay(100);
  }
}

/**
 * @brief Try to connect to one of the configured SSIDs (if available).
 * @details If more than 2 SSIDs configured, scan for available WIFIs and connect to the strongest
 * @return true on success
 * @return false on error or no configuration
 */
bool WIFIMANAGER::tryConnect() {
  // Setup may have already joined this network. Keep that live LAN connection
  // so the browser can receive its authenticated save acknowledgement.
  if (WiFi.status() == WL_CONNECTED) {
    const String connected = WiFi.SSID();
    for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; ++i) {
      if (!apList[i].apName.isEmpty() && apList[i].apName == connected) {
        connectCb();
        stopSoftAP();
        return true;
      }
    }
  }
  if (!configAvailable()) {
    logMessage("[WIFI] No SSIDs configured in NVS, unable to connect\n");
    if (createFallbackAP) runSoftAP();
    return false;
  }

  if (softApRunning) {
    logMessage("[WIFI] Not trying to connect. SoftAP has " + String(WiFi.softAPgetStationNum()) + " clients connected!\n");
    return false;
  }

  int choosenAp = INT_MIN;
  if (configuredSSIDs == 1) {
    // only one configured SSID, skip scanning and try to connect to this specific one.
    choosenAp = getApEntry();
  } else {
    WiFi.mode(WIFI_STA);
    int8_t scanResult = WiFi.scanNetworks(false, true);
    if(scanResult <= 0) {
      logMessage("[WIFI] Unable to find WIFI networks in range to this device!\n");
      return false;
    }
    logMessage(String("[WIFI] Found ") + String(scanResult) + " networks in range\n");
    int choosenRssi = INT_MIN;  // we want to select the strongest signal with the highest priority if we have multiple SSIDs available
    for(int8_t x = 0; x < scanResult; ++x) {
      String ssid;
      uint8_t encryptionType;
      int32_t rssi;
      uint8_t* bssid;
      int32_t channel;
      WiFi.getNetworkInfo(x, ssid, encryptionType, rssi, bssid, channel);
      for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
        if (apList[i].apName.length() == 0 || apList[i].apName != ssid) continue;

        if (rssi > choosenRssi) {
          if(encryptionType == WIFI_AUTH_OPEN || apList[i].apPass.length() > 0) { // open wifi or we do know a password
            choosenAp = i;
            choosenRssi = rssi;
          }
        } // else lower wifi signal
      }
    }
    WiFi.scanDelete();
  }

  if (choosenAp == INT_MIN) {
    logMessage("[WIFI] Unable to find an SSID to connect to!\n");
    return false;
  } else {
    logMessage(String("[WIFI] Trying to connect to SSID ") + apList[choosenAp].apName 
      + " with password " + (apList[choosenAp].apPass.length() > 0 ? "'***'" : "''") + "\n"
    );

    WiFi.begin(apList[choosenAp].apName.c_str(), apList[choosenAp].apPass.c_str());
    wl_status_t status = (wl_status_t)WiFi.waitForConnectResult(5000UL);

    auto startTime = millis();
    // wait for connection, fail, or timeout
    while(status != WL_CONNECTED && status != WL_NO_SSID_AVAIL && status != WL_CONNECT_FAILED && (millis() - startTime) <= 10000) {
        delay(10);
        status = (wl_status_t)WiFi.waitForConnectResult(5000UL);
    }
    switch(status) {
      case WL_IDLE_STATUS:
        logMessage("[WIFI] Connecting failed (0): Idle\n");
        break;
      case WL_NO_SSID_AVAIL:
        logMessage("[WIFI] Connecting failed (1): The AP can't be found\n");
        break;
      case WL_SCAN_COMPLETED:
        logMessage("[WIFI] Connecting failed (2): Scan completed\n");
        break;
      case WL_CONNECTED: // 3
        logMessage("[WIFI] Connection successful\n");
        logMessage("[WIFI] SSID   : " + WiFi.SSID() + "\n");
        logMessage("[WIFI] IP     : " + WiFi.localIP().toString() + "\n");
        connectCb();
        stopSoftAP();
        return true;
        break;
      case WL_CONNECT_FAILED:
        logMessage("[WIFI] Connecting failed (4): Unknown reason\n");
        break;
      case WL_CONNECTION_LOST:
        logMessage("[WIFI] Connecting failed (5): Connection lost\n");
        break;
      case WL_DISCONNECTED:
        logMessage("[WIFI] Connecting failed (6): Disconnected\n");
        break;
      case WL_NO_SHIELD:
        logMessage("[WIFI] Connecting failed (7): No Wifi shield found\n");
        break;
      default:
        logMessage("[WIFI] Connecting failed (" + String(status) + "): Unknown status code\n");
        break;
    }
  }
  return false;
}

void WIFIMANAGER::configueSoftAp(String apName, String apPass) {
  this->softApName = apName;
  this->softApPass = apPass;
}



/**
 * @brief Start a SoftAP for direct client access
 * @param apName name of the AP to create (default is ESP_XXXXXXXX)
 * @return true on success
 * @return false o error or if a SoftAP already runs
 */
bool WIFIMANAGER::runSoftAP(String apName, String apPass) {
  if (apName.length()) this->softApName = apName;
  if (apPass.length()) this->softApPass = apPass;

  if (softApRunning) return true;
  startApTimeMillis = millis();

  if (this->softApName == "") this->softApName = "ESP_" + String((uint32_t)ESP.getEfuseMac());
  logMessage("[WIFI] Starting configuration portal on AP SSID " + this->softApName + "\n");

  WiFi.mode(WIFI_AP);
  bool state = WiFi.softAP(this->softApName.c_str(), (this->softApPass.length() ? this->softApPass.c_str() : NULL));
  if (state) {
    IPAddress IP = WiFi.softAPIP();
    logMessage("[WIFI] AP created. My IP is: " + String(IP) + "\n");
    return true;
  } else {
    logMessage("[WIFI] Unable to create SoftAP!\n");
    return false;
  }
}

/**
 * @brief Stop/Disconnect a current running SoftAP
 */
void WIFIMANAGER::stopSoftAP() {
  WiFi.softAPdisconnect();
  WiFi.mode(WIFI_STA);
}

/**
 * @brief Stop/Disconnect a current wifi connection
 */
void WIFIMANAGER::stopClient() {
  WiFi.disconnect();
}

/**
 * @brief Stop/Disconnect all running wifi activies and optionally kill the background task as well
 * @param killTask true to kill the background task to prevent reconnects
 */
void WIFIMANAGER::stopWifi(bool killTask) {
  if (killTask) vTaskDelete(WifiCheckTask);
  stopSoftAP();
  stopClient();
}

/**
 * @brief Attach the WebServer to the WifiManager to register the RESTful API
 * @param srv WebServer object
 */
#if ASYNC_WEBSERVER == true
void WIFIMANAGER::attachWebServer(AsyncWebServer * srv) {
#else
void WIFIMANAGER::attachWebServer(WebServer * srv) {
#endif
  webServer = srv; // store it in the class for later use

#if ASYNC_WEBSERVER == true
  // not required
#else
  // just for debugging
  webServer->onNotFound([&]() {
    String uri = WebServer::urlDecode(webServer->uri());  // required to read paths with blanks

     // Dump debug data
    String message;
    message.reserve(100);
    message = F("Error: File not found\n\nURI: ");
    message += uri;
    message += F("\nMethod: ");
    message += (webServer->method() == HTTP_GET) ? "GET" : "POST";
    message += F("\nArguments: ");
    message += webServer->args();
    message += '\n';
    for (uint8_t i = 0; i < webServer->args(); i++) {
      message += F(" NAME:");
      message += webServer->argName(i);
      message += F("\n VALUE:");
      message += webServer->arg(i);
      message += '\n';
    }
    message += "path=";
    message += webServer->arg("path");
    message += '\n';
    logMessage(message);
  });
#endif

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/softap/start").c_str(), HTTP_POST, [&](AsyncWebServerRequest * request) {
    request->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#else
  webServer->on((apiPrefix + "/softap/start").c_str(), HTTP_POST, [&]() {
    webServer->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#endif
    yield();
    delay(250);
    runSoftAP();
  });
  
#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/softap/stop").c_str(), HTTP_POST, [&](AsyncWebServerRequest * request) {
    request->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#else
  webServer->on((apiPrefix + "/softap/stop").c_str(), HTTP_POST, [&]() {
    webServer->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#endif
    yield();
    delay(250); // It's likely that this message won't go trough, but we give it a short time
    stopSoftAP();
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/client/stop").c_str(), HTTP_POST, [&](AsyncWebServerRequest * request) {
    request->send(200, "application/json", "{\"message\":\"Terminating current Wifi connection\"}");
#else
  webServer->on((apiPrefix + "/client/stop").c_str(), HTTP_POST, [&]() {
    webServer->send(200, "application/json", "{\"message\":\"Terminating current Wifi connection\"}");
#endif
    yield();
    delay(500); // It's likely that this message won't go trough, but we give it a short time
    stopClient();
  });

#if ASYNC_WEBSERVER == true
  // The JSON handler assembles split body callbacks and bounds their size.
  // Raw body callbacks are not guaranteed to receive a null-terminated string.
  auto *addNetworkHandler = new AsyncCallbackJsonWebHandler(
    (apiPrefix + "/add").c_str(), [this](AsyncWebServerRequest *request, JsonVariant &json) {
      if (!json["apName"].is<String>() || !json["apPass"].is<String>()) {
        request->send(422, "application/json", "{\"message\":\"Enter a network name and password\"}");
        return;
      }
      const String apName = json["apName"].as<String>();
      const String apPass = json["apPass"].as<String>();
      if (apName.length() == 0 || apName.length() > 32 || apPass.length() > 63) {
        request->send(422, "application/json", "{\"message\":\"Invalid network name or password length\"}");
        return;
      }
      if (!addWifi(apName, apPass)) {
        request->send(500, "application/json", "{\"message\":\"Unable to save the network\"}");
        return;
      }
      request->send(200, "application/json", "{\"message\":\"Network saved. Press Reset on the Cardputer to connect.\"}");
    });
  addNetworkHandler->setMethod(HTTP_POST);
  addNetworkHandler->setMaxContentLength(512);
  webServer->addHandler(addNetworkHandler);
#else
  webServer->on((apiPrefix + "/add").c_str(), HTTP_POST, [&]() {
    if (webServer->args() != 1 || webServer->arg(0).length() > 512) {
      webServer->send(400, "application/json", "{\"message\":\"Invalid network request\"}");
      return;
    }
    JsonDocument jsonBuffer;
    const DeserializationError parseError = deserializeJson(jsonBuffer, webServer->arg(0));
    if (parseError || !jsonBuffer["apName"].is<String>() || !jsonBuffer["apPass"].is<String>()) {
      webServer->send(422, "application/json", "{\"message\":\"Enter a network name and password\"}");
      return;
    }
    const String apName = jsonBuffer["apName"].as<String>();
    const String apPass = jsonBuffer["apPass"].as<String>();
    if (apName.length() == 0 || apName.length() > 32 || apPass.length() > 63) {
      webServer->send(422, "application/json", "{\"message\":\"Invalid network name or password length\"}");
      return;
    }
    if (!addWifi(apName, apPass)) {
      webServer->send(500, "application/json", "{\"message\":\"Unable to save the network\"}");
    } else webServer->send(200, "application/json", "{\"message\":\"Network saved. Press Reset on the Cardputer to connect.\"}");
  });
#endif

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/id").c_str(), HTTP_DELETE, [&](AsyncWebServerRequest * request){}, NULL,
    [&](AsyncWebServerRequest * request, uint8_t *data, size_t len, size_t index, size_t total) {
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, (const char*)data);
    auto resp = request;
#else
  webServer->on((apiPrefix + "/id").c_str(), HTTP_DELETE, [&]() {
    if (webServer->args() != 1) {
      webServer->send(400, "application/json", "{\"message\":\"Bad Request. Only accepting one json body in request!\"}");
    }
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, webServer->arg(0));
    auto resp = webServer;
#endif
    int idValue = jsonBuffer["id"].as<String>().toInt();
    if (idValue < 0 || idValue >= WIFIMANAGER_MAX_APS) {
      resp->send(422, "application/json", "{\"message\":\"Invalid data\"}");
      return;
    }
    if (!delWifi(jsonBuffer["id"].as<uint8_t>())) {
      resp->send(500, "application/json", "{\"message\":\"Unable to delete entry\"}");
    } else resp->send(200, "application/json", "{\"message\":\"AP deleted\"}");
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/apName").c_str(), HTTP_DELETE, [&](AsyncWebServerRequest * request){}, NULL,
    [&](AsyncWebServerRequest * request, uint8_t *data, size_t len, size_t index, size_t total) {
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, (const char*)data);
    auto resp = request;
#else
  webServer->on((apiPrefix + "/apName").c_str(), HTTP_DELETE, [&]() {
    if (webServer->args() != 1) {
      webServer->send(400, "application/json", "{\"message\":\"Bad Request. Only accepting one json body in request!\"}");
    }
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, webServer->arg(0));
    auto resp = webServer;
#endif
    if (!jsonBuffer["apName"].is<String>()) {
      resp->send(422, "application/json", "{\"message\":\"Invalid data\"}");
      return;
    }
    if (!delWifi(jsonBuffer["apName"].as<String>())) {
      resp->send(500, "application/json", "{\"message\":\"Unable to delete entry\"}");
    } else resp->send(200, "application/json", "{\"message\":\"AP deleted\"}");
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/configlist").c_str(), HTTP_GET, [&](AsyncWebServerRequest *request) {
    AsyncResponseStream *response = request->beginResponseStream("application/json");
#else
  webServer->on((apiPrefix + "/configlist").c_str(), HTTP_GET, [&]() {
    String buffer;
#endif
    JsonDocument jsonDoc;
    auto jsonArray = jsonDoc.to<JsonArray>();
    for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
      if (apList[i].apName.length() > 0) {
        JsonObject wifiNet = jsonArray.createNestedObject();
        wifiNet["id"] = i;
        wifiNet["apName"] = apList[i].apName;
        wifiNet["apPass"] = apList[i].apPass.length() > 0 ? true : false;
      }
    }
#if ASYNC_WEBSERVER == true
    serializeJson(jsonArray, *response);
    response->setCode(200);
    response->setContentLength(measureJson(jsonDoc));
    request->send(response);
#else
    // Improve me: not that efficient without the stream response
    serializeJson(jsonArray, buffer);
    webServer->send(200, "application/json", (buffer.equals("null") ? "{}" : buffer));
#endif
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/scan").c_str(), HTTP_GET, [&](AsyncWebServerRequest *request) {
    AsyncResponseStream *response = request->beginResponseStream("application/json");
#else
  webServer->on((apiPrefix + "/scan").c_str(), HTTP_GET, [&]() {
    String buffer;
#endif
    JsonDocument jsonDoc;

    int16_t scanResult;
    String ssid;
    uint8_t encryptionType;
    int32_t rssi;
    uint8_t* bssid;
    int32_t channel;

    scanResult = WiFi.scanComplete();
    if (scanResult == WIFI_SCAN_FAILED) {
      // Scanning can interrupt AP traffic, so the page starts this only after
      // the user explicitly presses Scan. Repeated GETs poll the same route.
      scanResult = WiFi.scanNetworks(true, true);
    }
    if (scanResult == WIFI_SCAN_RUNNING) {
      jsonDoc["status"] = "scanning";
    } else if (scanResult >= 0) {
      jsonDoc["status"] = "complete";
      JsonArray foundNetworks = jsonDoc["networks"].to<JsonArray>();
      const int16_t resultCount = min(scanResult, int16_t{64});
      for (int16_t i = 0; i < resultCount; i++) {
        if (!WiFi.getNetworkInfo(i, ssid, encryptionType, rssi, bssid, channel)) continue;
        JsonObject wifiNet = foundNetworks.add<JsonObject>();
        wifiNet["ssid"] = ssid;
        wifiNet["encryptionType"] = encryptionType;
        wifiNet["rssi"] = rssi;
        wifiNet["channel"] = channel;
        yield();
      }
      WiFi.scanDelete();
    } else {
      jsonDoc["status"] = "failed";
      jsonDoc["message"] = "Scan failed. Use Manual Connect to enter your Wi-Fi details.";
    }
#if ASYNC_WEBSERVER == true
    serializeJson(jsonDoc, *response);
    response->setCode(200);
    response->addHeader("Cache-Control", "no-store");
    response->setContentLength(measureJson(jsonDoc));
    request->send(response);
#else
    // Improve me: not that efficient without the stream response
    serializeJson(jsonDoc, buffer);
    webServer->send(200, "application/json", buffer);
#endif
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/status").c_str(), HTTP_GET, [&](AsyncWebServerRequest *request) {
    AsyncResponseStream *response = request->beginResponseStream("application/json");
#else
  webServer->on((apiPrefix + "/status").c_str(), HTTP_GET, [&]() {
    String buffer;
#endif
    JsonDocument jsonDoc;

    jsonDoc["ssid"] = WiFi.SSID();
    jsonDoc["signalStrengh"] = WiFi.RSSI();

    jsonDoc["ip"] = WiFi.localIP().toString();
    jsonDoc["gw"] = WiFi.gatewayIP().toString();
    jsonDoc["nm"] = WiFi.subnetMask().toString();

    jsonDoc["hostname"] = WiFi.getHostname();

    jsonDoc["chipModel"] = ESP.getChipModel();
    jsonDoc["chipRevision"] = ESP.getChipRevision();
    jsonDoc["chipCores"] = ESP.getChipCores();

    jsonDoc["getHeapSize"] = ESP.getHeapSize();
    jsonDoc["freeHeap"] = ESP.getFreeHeap();

#if ASYNC_WEBSERVER == true
    serializeJson(jsonDoc, *response);
    response->setCode(200);
    response->setContentLength(measureJson(jsonDoc));
    request->send(response);
#else
    // Improve me: not that efficient without the stream response
    serializeJson(jsonDoc, buffer);
    webServer->send(200, "application/json", buffer);
#endif
  });
}

/**
 * @brief Attach the WebServer to the WifiManager to register the RESTful API
 * @param srv WebServer object
 */
void WIFIMANAGER::attachUI() {

#if ASYNC_WEBSERVER == true
  webServer->on((uiPrefix).c_str(), HTTP_GET, [](AsyncWebServerRequest* request) {
#else
  webServer->on((uiPrefix).c_str(), HTTP_GET, [&]() {
#endif

    String html = R"html(
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>__DEVICE_TITLE__ Wi-Fi setup</title>
    <style>
        :root {
            --primary-color: #2563eb;
            --bg-color: #f8fafc;
            --card-bg: #ffffff;
            --text-color: #1e293b;
            --border-color: #e2e8f0;
        }

        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: var(--bg-color);
            color: var(--text-color);
            margin: 0;
            padding: 16px;
            line-height: 1.5;
        }

        .container {
            max-width: 600px;
            margin: 0 auto;
        }

        .card {
            background: var(--card-bg);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            border: 1px solid var(--border-color);
        }

        h1, h2 {
            margin: 0 0 16px 0;
            color: var(--text-color);
        }

        .network-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }

        .network-item {
            display: flex;
            align-items: center;
            padding: 12px;
            border-bottom: 1px solid var(--border-color);
            cursor: pointer;
            transition: background-color 0.2s;
        }

        .network-item:last-child {
            border-bottom: none;
        }

        .network-item:hover {
            background-color: var(--bg-color);
        }

        .network-info {
            flex-grow: 1;
        }

        .network-info div {
          float: left;
          width: 70%;
        }

        .network-info button {
          float: right;
          width: 30%;
        }

        .ssid {
            font-weight: 500;
            margin-bottom: 4px;
        }

        .signal {
            font-size: 0.875rem;
            color: #64748b;
        }

        button {
            background: var(--primary-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.875rem;
            transition: opacity 0.2s;
        }

        button:hover {
            opacity: 0.9;
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .status {
            padding: 8px;
            border-radius: 4px;
            margin-bottom: 16px;
            display: none;
        }

        .status.error {
            background: #fee2e2;
            color: #991b1b;
            display: block;
        }

        .status.success {
            background: #dcfce7;
            color: #166534;
            display: block;
        }

        .status.info {
            background: #e0f2fe;
            color: #075985;
            display: block;
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            align-items: center;
            justify-content: center;
        }

        .modal-content {
            background: var(--card-bg);
            padding: 24px;
            border-radius: 8px;
            width: 90%;
            max-width: 400px;
        }

        input {
            width: 100%;
            padding: 8px;
            margin: 8px 0 16px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            box-sizing: border-box;
            font-size: 16px;
        }

        .button-group {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }

        .button-secondary {
            background: var(--bg-color);
            color: var(--text-color);
            border: 1px solid var(--border-color);
        }

        .saved-networks {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--border-color);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>__DEVICE_TITLE__ Wi-Fi setup</h1>
            <p>Enter your 2.4 GHz Wi-Fi details, save them, then press Reset on the Cardputer.</p>
            <div id="status" class="status info">Manual Connect is ready. Scanning is optional.</div>
            <button onclick="showConnectModal()">Manual Connect</button>
            <button id="scanButton" onclick="scanNetworks()">Scan for Networks</button>
        </div>

        <div class="card">
            <h2>✅ Saved Networks</h2>
            <div id="savedNetworks" class="network-list"></div>
        </div>

        <div class="card">
            <h2>🛜 Available Networks</h2>
            <div id="networkList" class="network-list"></div>
        </div>
    </div>

    <div id="connectModal" class="modal">
        <div class="modal-content">
            <h2>Connect to Network</h2>
            <form id="connectForm" onsubmit="connectToNetwork(event)">
                <label for="apName">Network Name:</label>
                <input type="text" id="apName" maxlength="32" autocomplete="off" spellcheck="false" required>
                
                <label for="apPass">Password:</label>
                <input type="password" id="apPass" maxlength="63" autocomplete="current-password">
                <p>Leave the password blank only for an open Wi-Fi network.</p>
                
                <div class="button-group">
                    <button type="button" class="button-secondary" onclick="closeModal()">Cancel</button>
                    <button id="saveButton" type="submit">Save Wi-Fi</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        const API_BASE = '/api';
        let scanning = false;

        // A radio scan can interrupt the phone's AP connection. Do not scan
        // automatically while the user is trying to open this page.
        window.addEventListener('load', () => {
            loadSavedNetworks();
        });

        async function fetchJson(path, options = {}) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await fetch(`${API_BASE}${path}`, {
                    cache: 'no-store', ...options, signal: controller.signal,
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Request failed');
                return result;
            } finally {
                clearTimeout(timeout);
            }
        }

        async function loadSavedNetworks() {
            try {
                const savedNetworks = await fetchJson('/wifi/configlist');
                displaySavedNetworks(savedNetworks);
            } catch (error) {
                showStatus('Failed to load saved networks: ' + error.message, 'error');
            }
        }

        function displaySavedNetworks(networks) {
            const networkList = document.getElementById('savedNetworks');
            const networkArray = Object.values(networks || {});
            networkList.replaceChildren();
            
            if (networkArray.length === 0) {
                networkList.textContent = 'No saved networks';
                return;
            }

            for (const network of networkArray) {
                const row = document.createElement('div');
                row.className = 'network-item';
                const name = document.createElement('div');
                name.className = 'network-info';
                name.textContent = network.apName;
                const remove = document.createElement('button');
                remove.textContent = 'Remove';
                remove.onclick = () => deleteNetwork(Number(network.id));
                row.append(name, remove);
                networkList.append(row);
            }
        }

        async function scanNetworks() {
            if (scanning) return;
            scanning = true;
            document.getElementById('scanButton').disabled = true;
            try {
                showStatus('Scanning. The Wi-Fi connection may briefly pause; Manual Connect does not need a scan.', 'info');
                for (let attempt = 0; attempt < 20; attempt++) {
                    const result = await fetchJson('/wifi/scan');
                    if (result.status === 'complete') {
                        displayNetworks(result.networks || []);
                        showStatus('Scan complete. Select your network or use Manual Connect.', 'success');
                        return;
                    }
                    if (result.status !== 'scanning') {
                        throw new Error(result.message || 'Network scan failed');
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                throw new Error('Scan timed out. Use Manual Connect instead.');
            } catch (error) {
                showStatus('Scan unavailable. Stay on __SETUP_NETWORK__ and use Manual Connect.', 'error');
            } finally {
                scanning = false;
                document.getElementById('scanButton').disabled = false;
            }
        }

        function displayNetworks(networks) {
            const networkList = document.getElementById('networkList');
            const networkArray = Object.values(networks || {})
              .filter(network => network && typeof network.ssid === 'string' && network.ssid.length > 0);
            networkList.replaceChildren();
            
            if (networkArray.length === 0) {
                networkList.textContent = 'No networks found. Use Manual Connect.';
                return;
            }

            // Sort networks by RSSI
            networkArray.sort((a, b) => b.rssi - a.rssi);

            for (const network of networkArray) {
                const row = document.createElement('div');
                row.className = 'network-item';
                row.onclick = () => showConnectModal(network.ssid);
                const info = document.createElement('div');
                info.className = 'network-info';
                const name = document.createElement('div');
                name.className = 'ssid';
                name.textContent = network.ssid;
                const signal = document.createElement('div');
                signal.className = 'signal';
                signal.textContent = `Signal: ${getSignalStrength(network.rssi)} ${network.encryptionType > 0 ? '(password)' : '(open)'}`;
                info.append(name, signal);
                row.append(info);
                networkList.append(row);
            }
        }

        function getSignalStrength(rssi) {
            if (rssi >= -50) return 'Excellent';
            if (rssi >= -60) return 'Very Good';
            if (rssi >= -70) return 'Good';
            if (rssi >= -80) return 'Fair';
            return 'Poor';
        }

        function showConnectModal(apName = '') {
            document.getElementById('apName').value = apName;
            document.getElementById('apName').readOnly = !!apName;
            document.getElementById('apPass').value = '';
            document.getElementById('connectModal').style.display = 'flex';
        }

        function closeModal() {
            document.getElementById('connectModal').style.display = 'none';
        }

        async function deleteNetwork(deleteId) {
            try {
                await fetchJson('/wifi/id', {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ id: deleteId }),
                });
                
                showStatus('Network deleted successfully', 'success');
                await loadSavedNetworks(); // Refresh the list
            } catch (error) {
                showStatus('Failed to delete network: ' + error.message, 'error');
            }
        }

        async function connectToNetwork(event) {
            event.preventDefault();
            const apName = document.getElementById('apName').value;
            const apPass = document.getElementById('apPass').value;
            const saveButton = document.getElementById('saveButton');
            saveButton.disabled = true;

            try {
                showStatus('Saving Wi-Fi details...', 'info');
                await fetchJson('/wifi/add', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ apName, apPass }),
                });

                closeModal();
                showStatus('Wi-Fi saved. Press Reset on the Cardputer now. Then reconnect your phone or computer to your normal Wi-Fi.', 'success');
                
                // Refresh saved networks list
                await loadSavedNetworks();
            } catch (error) {
                showStatus(error.message, 'error');
            } finally {
                saveButton.disabled = false;
            }
        }

        function showStatus(message, type) {
            const statusElement = document.getElementById('status');
            statusElement.textContent = message;
            statusElement.className = `status ${type}`;
        }
    </script>
</body>
</html>
)html";

#if defined(INDEPENDENT_MODE)
    html.replace("__DEVICE_TITLE__", "Cardputer Voice");
    html.replace("__SETUP_NETWORK__", "CARDPUTER-SETUP");
#else
    html.replace("__DEVICE_TITLE__", "ElatoAI");
    html.replace("__SETUP_NETWORK__", "ELATO-DEVICE");
#endif

#if ASYNC_WEBSERVER == true
    request->send(200, "text/html", html);
#else
    webServer->send(200, "text/html", html);
#endif

  });
}

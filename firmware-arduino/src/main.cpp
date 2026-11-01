#if !defined(ELATO_CARDPUTER)
#include "Button.h"
#endif
#include "Cardputer.h"
#include "FactoryReset.h"
#include "LEDHandler.h"
#include "OTA.h"
#include "WifiManager.h"
#if !defined(ELATO_CARDPUTER)
#include <driver/touch_sensor.h>
#endif

#if !defined(ELATO_CARDPUTER)
#define TOUCH_THRESHOLD 28000
#define REQUIRED_RELEASE_CHECKS                                                \
  100 // how many consecutive times we need "below threshold" to confirm release
#define TOUCH_DEBOUNCE_DELAY 500 // milliseconds
#endif

AsyncWebServer webServer(80);
WIFIMANAGER WifiManager;
esp_err_t getErr = ESP_OK;

// Main Thread -> onButtonLongPressUpEventCb -> enterSleep()
// Main Thread -> onButtonDoubleClickCb -> enterSleep()
// Touch Task -> touchTask -> enterSleep()
// Main Thread -> loop() (inactivity timeout) -> enterSleep()
void enterSleep() {
  Serial.println("Going to sleep...");

  // First, change device state to prevent any new data processing
  deviceState = SLEEP;
  scheduleListeningRestart = false;
  i2sOutputFlushScheduled = true;
  i2sInputFlushScheduled = true;
  vTaskDelay(10); // let all tasks accept state

  xSemaphoreTake(wsMutex, portMAX_DELAY);

  // Properly disconnect WebSocket and wait for it to complete
  if (webSocket.isConnected()) {
    webSocket.disconnect();
    // Give some time for the disconnect to process
  }
  xSemaphoreGive(wsMutex);
  delay(100);

  shutdownAudioHardware();

  // Flush any remaining serial output
  Serial.flush();

#if defined(ELATO_CARDPUTER)
  prepareCardputerForSleep();
#elif defined(TOUCH_MODE)
  touch_pad_intr_disable(TOUCH_PAD_INTR_MASK_ALL);
  while (touchRead(TOUCH_PAD_NUM2) > TOUCH_THRESHOLD) {
    delay(50);
  }
  delay(500);
  touchSleepWakeUpEnable(TOUCH_PAD_NUM2, TOUCH_THRESHOLD);
#endif

  esp_deep_sleep_start();
  delay(1000);
}

void processSleepRequest() {
  if (sleepRequested) {
    sleepRequested = false;
    enterSleep(); // Just call it directly - no state checking needed
  }
}

void printOutESP32Error(esp_err_t err) {
  switch (err) {
  case ESP_OK:
    Serial.println("ESP_OK no errors");
    break;
  case ESP_ERR_INVALID_ARG:
    Serial.println("ESP_ERR_INVALID_ARG if the selected GPIO is not an RTC "
                   "GPIO, or the mode is invalid");
    break;
  case ESP_ERR_INVALID_STATE:
    Serial.println("ESP_ERR_INVALID_STATE if wakeup triggers conflict or "
                   "wireless not stopped");
    break;
  default:
    Serial.printf("Unknown error code: %d\n", err);
    break;
  }
}

#if !defined(ELATO_CARDPUTER)
static void onButtonLongPressUpEventCb(void *button_handle, void *usr_data) {
  Serial.println("Button long press end");
  delay(10);
  sleepRequested = true;
}

static void onButtonDoubleClickCb(void *button_handle, void *usr_data) {
  Serial.println("Button double click");
  delay(10);
  sleepRequested = true;
}
#endif

void getAuthTokenFromNVS() {
#if defined(INDEPENDENT_MODE)
  // A MAC address identifies the device; it is not an authentication secret.
  // Independent builds use the revocable random credential issued by the owner.
  authTokenGlobal = CARDPUTER_DEVICE_TOKEN;
#else
  preferences.begin("auth", false);
  authTokenGlobal = preferences.getString("auth_token", "");
  preferences.end();
#endif
}

void setupWiFi() {
#if defined(ELATO_CARDPUTER)
  // A handheld setup flow needs enough time to switch networks and complete
  // the captive-portal form without the AP cycling underneath the browser.
  WifiManager.setSoftApTimeout(10 * 60 * 1000UL);
#endif
  WifiManager.startBackgroundTask(
#if defined(INDEPENDENT_MODE)
      "CARDPUTER-SETUP");
#else
      "ELATO-DEVICE"); // Run the background task to take care of our Wifi
#endif
  WifiManager.fallbackToSoftAp(
      true); // Run a SoftAP if no known AP can be reached
  WifiManager.attachWebServer(&webServer); // Attach our API to the Webserver
  WifiManager.attachUI();                  // Attach the UI to the Webserver

  // Run the Webserver and add your webpages to it
  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->redirect("/wifi");
  });
  webServer.onNotFound([](AsyncWebServerRequest *request) {
    request->send(404, "text/plain", "Not found");
  });
  webServer.begin();
}

#if !defined(ELATO_CARDPUTER)
void touchTask(void *parameter) {
  touch_pad_init();
  touch_pad_config(TOUCH_PAD_NUM2);

  bool touched = false;
  unsigned long pressStartTime = 0;
  unsigned long lastTouchTime = 0;
  const unsigned long LONG_PRESS_DURATION = 500; // 500ms for long press

  while (1) {
    // Read the touch sensor
    uint32_t touchValue = touchRead(TOUCH_PAD_NUM2);
    bool isTouched = (touchValue > TOUCH_THRESHOLD);
    unsigned long currentTime = millis();

    // Initial touch detection
    if (isTouched && !touched &&
        (currentTime - lastTouchTime > TOUCH_DEBOUNCE_DELAY)) {
      touched = true;
      pressStartTime = currentTime; // Start timing the press
      lastTouchTime = currentTime;
    }

    // Check for long press while touched
    if (touched && isTouched) {
      if (currentTime - pressStartTime >= LONG_PRESS_DURATION) {
        sleepRequested =
            true; // Only enter sleep after 500ms of continuous touch
      }
    }

    // Release detection
    if (!isTouched && touched) {
      touched = false;
      pressStartTime = 0; // Reset the press timer
    }

    vTaskDelay(20); // Reduced from 50ms to 20ms for better responsiveness
  }
  vTaskDelete(NULL);
}
#endif

void setupDeviceMetadata() {
  // factoryResetDevice();
  // resetAuth();

  deviceState = IDLE;

  getAuthTokenFromNVS();
#if defined(INDEPENDENT_MODE)
  // This edition uses USB updates. Ignore any OTA flag left by hosted firmware.
  otaState = OTA_IDLE;
#else
  getOTAStatusFromNVS();
#endif

  if (otaState == OTA_IN_PROGRESS || otaState == OTA_COMPLETE) {
    deviceState = OTA;
  }
  if (factory_reset_status) {
    deviceState = FACTORY_RESET;
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

#if defined(ELATO_CARDPUTER)
  setupCardputerHardware();
#endif

  // SETUP
  setupDeviceMetadata();
  wsMutex = xSemaphoreCreateMutex();

// INTERRUPT
#if defined(ELATO_CARDPUTER)
  getErr = esp_sleep_enable_ext0_wakeup(GPIO_NUM_0, LOW);
  printOutESP32Error(getErr);
#elif defined(TOUCH_MODE)
  xTaskCreate(touchTask, "Touch Task", 4096, NULL, configMAX_PRIORITIES - 2,
              NULL);
#else
  getErr = esp_sleep_enable_ext0_wakeup(BUTTON_PIN, LOW);
  printOutESP32Error(getErr);
  Button *btn = new Button(BUTTON_PIN, false);
  btn->attachLongPressUpEventCb(&onButtonLongPressUpEventCb, NULL);
  btn->attachDoubleClickEventCb(&onButtonDoubleClickCb, NULL);
  btn->detachSingleClickEvent();
#endif

#if defined(ELATO_CARDPUTER)
  constexpr uint32_t indicatorTaskStack = 6144;
  constexpr UBaseType_t indicatorTaskPriority = 1;
  // Cardputer builds compile libopus with VAR_ARRAYS, so SILK scratch storage
  // lives on this task stack instead of a failure-prone 120 KB heap block.
  constexpr uint32_t networkTaskStack = 32768;
#else
  constexpr uint32_t indicatorTaskStack = 4096;
  constexpr UBaseType_t indicatorTaskPriority = 5;
  constexpr uint32_t networkTaskStack = 8192;
#endif

  // Pin the UI/LED and audio tasks to Core 1 (application core). Cardputer's
  // display task stays below audio priority so a screen refresh cannot glitch
  // microphone capture or speaker playback.
  xTaskCreatePinnedToCore(ledTask,    // Function
                          "LED Task", // Name
                          indicatorTaskStack,
                          NULL,       // Parameters
                          indicatorTaskPriority,
                          NULL,       // Handle
                          1           // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(audioStreamTask, // Function
                          "Speaker Task",  // Name
                          4096,            // Stack size
                          NULL,            // Parameters
                          3,               // Priority
                          NULL,            // Handle
                          1                // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(micTask,           // Function
                          "Microphone Task", // Name
                          4096,              // Stack size
                          NULL,              // Parameters
                          4,                 // Priority
                          NULL,              // Handle
                          1                  // Core 1 (application core)
  );

  // Pin network task to Core 0 (protocol core)
  xTaskCreatePinnedToCore(networkTask,              // Function
                          "Websocket Task",         // Name
                          networkTaskStack,          // Stack size
                          NULL,                     // Parameters
                          configMAX_PRIORITIES - 1, // Highest priority
                          &networkTaskHandle,       // Handle
                          0                         // Core 0 (protocol core)
  );

  // WIFI
  setupWiFi();
}

void loop() {
  processSleepRequest();
#if defined(ELATO_CARDPUTER)
  // Recover only when the stream has stopped making progress. Long replies
  // may legitimately exceed a minute, so total speaking time is not a useful
  // failure signal. RESPONSE.COMPLETE disarms this timer immediately.
  if (deviceState == SPEAKING && getSpeakingDuration() > 5000 &&
      getResponseInactivityDuration() > 45000) {
    Serial.println("Voice stream inactive; restarting audio session");
    ESP.restart();
  }
#endif
  if (otaState == OTA_IN_PROGRESS) {
    loopOTA();
  }
}

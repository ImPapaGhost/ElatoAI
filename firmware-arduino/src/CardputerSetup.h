#ifndef CARDPUTER_SETUP_H
#define CARDPUTER_SETUP_H

#if defined(ELATO_CARDPUTER)
#include <Arduino.h>

class WIFIMANAGER;

struct CardputerProviderConfig {
  String provider = "gemini";
  String apiKey;
  String referenceId;
  String voice = "Aoede";
};

void loadCardputerProviderConfig();
const CardputerProviderConfig &getCardputerProviderConfig();
bool cardputerProviderConfigured();
bool consumeCardputerSetupRequest();
void requestCardputerSetupOnNextBoot();
// Poll from the normal LED task too, so USB requests outside the boot setup
// receive a bounded protocol error rather than waiting forever.
void pollCardputerUsbSetup();
// The LED task consumes this after USB polling and performs its normal
// graceful voice disconnect/restart, after the acknowledgement has been sent.
bool consumeCardputerUsbReopenRequest();

// Call after M5Cardputer.begin() and manager.loadFromNVS(), BEFORE creating
// LED/audio/network/Wi-Fi tasks. This boot-only UI owns the display/keyboard.
void runCardputerBootSetup(WIFIMANAGER &manager, bool force = false);
#endif

#endif

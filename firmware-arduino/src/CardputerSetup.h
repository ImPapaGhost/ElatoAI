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

// Call after M5Cardputer.begin() and manager.loadFromNVS(), BEFORE creating
// LED/audio/network/Wi-Fi tasks. This boot-only UI owns the display/keyboard.
void runCardputerBootSetup(WIFIMANAGER &manager, bool force = false);
#endif

#endif

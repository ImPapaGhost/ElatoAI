#ifndef CARDPUTER_WIRELESS_SETUP_H
#define CARDPUTER_WIRELESS_SETUP_H

#if defined(ELATO_CARDPUTER) && defined(CARDPUTER_WIRELESS_SETUP)
#include <Arduino.h>

struct CardputerWirelessPairing {
  String deviceId;
  String host;
  String ip;
  String controlSecret;
  uint16_t port = 8080;
};

// Plain bounded queue item: AsyncTCP never writes to boot UI Strings/state.
struct CardputerWirelessRequest {
  char operationId[25] = {};
  char json[1025] = {};
  unsigned long acceptedMillis = 0;
};

void initialiseCardputerWirelessSetup();
// Result of the once-per-boot public fixture self-test; contains no user data.
bool cardputerWirelessCryptoReady();
void pollCardputerWirelessSetup();
void setCardputerWirelessSetupActive(bool active);
bool consumeCardputerWirelessReopenRequest();
bool takeCardputerWirelessSetupRequest(CardputerWirelessRequest &request);
void publishCardputerWirelessSetupResult(const char *operationId, const char *type, const char *code = nullptr);

// Call ONLY after a fresh physical USB pairing confirmation. This is the only
// path that generates/rotates the dedicated LAN control secret.
bool pairCardputerWirelessSetup(CardputerWirelessPairing &pairing);
#endif

#endif

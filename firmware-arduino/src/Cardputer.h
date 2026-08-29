#ifndef CARDPUTER_H
#define CARDPUTER_H

#if defined(ELATO_CARDPUTER)

#include <M5Cardputer.h>

// Print-compatible PCM sink used by Arduino Audio Tools. M5Unified keeps
// pointers to queued audio, so three rotating buffers are used to guarantee
// that a buffer is not reused while the Cardputer speaker still owns it.
class CardputerSpeakerOutput : public Print {
public:
  size_t write(uint8_t value) override;
  size_t write(const uint8_t *data, size_t length) override;

  // Queue a final partial PCM block, or discard every queued block.
  void flushAudio();
  void discardAudio();
  void clearBuffer();
  bool isPlaybackPending();

private:
  static constexpr size_t BUFFER_SAMPLES = 960; // 20 ms at 48 kHz
  static constexpr size_t BUFFER_BYTES = BUFFER_SAMPLES * sizeof(int16_t);

  void submitBuffer();

  alignas(int16_t) uint8_t buffers_[3][BUFFER_BYTES] = {};
  size_t bufferIndex_ = 0;
  size_t bufferedBytes_ = 0;
  size_t submittedBlocks_ = 0;
  bool faulted_ = false;
};

extern CardputerSpeakerOutput cardputerSpeakerOutput;

void setupCardputerHardware();
bool cardputerEnterSpeakerMode();
bool cardputerEnterMicrophoneMode();
void stopCardputerAudio();
bool readCardputerMicrophone(int16_t *samples, size_t sampleCount);
void prepareCardputerForSleep();

#endif // ELATO_CARDPUTER

#endif // CARDPUTER_H

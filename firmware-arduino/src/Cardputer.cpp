#include "Cardputer.h"

#if defined(ELATO_CARDPUTER)

#include "Config.h"
#include <esp_heap_caps.h>

namespace {

SemaphoreHandle_t cardputerAudioMutex = nullptr;

enum class CardputerAudioMode : uint8_t {
  Idle,
  Microphone,
  Speaker,
};

CardputerAudioMode cardputerAudioMode = CardputerAudioMode::Idle;

class AudioLock {
public:
  AudioLock() {
    if (cardputerAudioMutex != nullptr) {
      xSemaphoreTake(cardputerAudioMutex, portMAX_DELAY);
      locked_ = true;
    }
  }

  ~AudioLock() {
    if (locked_) {
      xSemaphoreGive(cardputerAudioMutex);
    }
  }

private:
  bool locked_ = false;
};

void waitForMicrophone() {
  while (M5Cardputer.Mic.isRecording()) {
    vTaskDelay(1);
  }
}

bool beginSpeakerWithRetry() {
  for (uint8_t attempt = 1; attempt <= 5; ++attempt) {
    if (M5Cardputer.Speaker.begin()) {
      return true;
    }

    Serial.printf("Cardputer speaker start attempt %u failed (free=%u largest=%u)\n",
                  attempt, ESP.getFreeHeap(),
                  heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    M5Cardputer.Speaker.end();
    vTaskDelay((20 * attempt) / portTICK_PERIOD_MS);
  }
  return false;
}

bool beginMicrophoneWithRetry() {
  for (uint8_t attempt = 1; attempt <= 5; ++attempt) {
    if (M5Cardputer.Mic.begin()) {
      return true;
    }

    Serial.printf("Cardputer microphone start attempt %u failed (free=%u largest=%u)\n",
                  attempt, ESP.getFreeHeap(),
                  heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    M5Cardputer.Mic.end();
    vTaskDelay((20 * attempt) / portTICK_PERIOD_MS);
  }
  return false;
}

} // namespace

size_t CardputerSpeakerOutput::write(uint8_t value) {
  return write(&value, 1);
}

size_t CardputerSpeakerOutput::write(const uint8_t *data, size_t length) {
  if (data == nullptr || length == 0) {
    return 0;
  }

  AudioLock lock;
  if (deviceState != SPEAKING) {
    return length;
  }

  if (faulted_) {
    return length;
  }

  if (!M5Cardputer.Speaker.isRunning()) {
    return length;
  }

  size_t copied = 0;
  while (copied < length) {
    if (bufferedBytes_ == BUFFER_BYTES) {
      submitBuffer();
    }

    const size_t available = BUFFER_BYTES - bufferedBytes_;
    const size_t chunk = min(available, length - copied);
    memcpy(&buffers_[bufferIndex_][bufferedBytes_], &data[copied], chunk);
    bufferedBytes_ += chunk;
    copied += chunk;
  }

  return copied;
}

void CardputerSpeakerOutput::submitBuffer() {
  const size_t playableBytes = bufferedBytes_ & ~size_t{1};
  if (playableBytes == 0) {
    return;
  }

  const bool hasTrailingByte = playableBytes != bufferedBytes_;
  const uint8_t trailingByte =
      hasTrailingByte ? buffers_[bufferIndex_][playableBytes] : 0;

  const unsigned long queueWaitStarted = millis();
  while (M5Cardputer.Speaker.isPlaying(0) >= 2 &&
         millis() - queueWaitStarted < 500) {
    vTaskDelay(1);
  }

  if (M5Cardputer.Speaker.isPlaying(0) >= 2) {
    Serial.println("Cardputer speaker queue timed out; dropping one PCM block");
    faulted_ = true;
    bufferIndex_ = (bufferIndex_ + 1) % 3;
    bufferedBytes_ = 0;
    if (hasTrailingByte) {
      buffers_[bufferIndex_][0] = trailingByte;
      bufferedBytes_ = 1;
    }
    return;
  }

  const bool accepted = M5Cardputer.Speaker.playRaw(
      reinterpret_cast<const int16_t *>(buffers_[bufferIndex_]),
      playableBytes / sizeof(int16_t), SAMPLE_RATE, false, 1, 0, false);

  if (!accepted) {
    Serial.println("Cardputer speaker queue rejected a PCM block");
    faulted_ = true;
  } else if (submittedBlocks_++ == 0) {
    int32_t peak = 0;
    const int16_t *samples =
        reinterpret_cast<const int16_t *>(buffers_[bufferIndex_]);
    for (size_t index = 0; index < playableBytes / sizeof(int16_t); ++index) {
      const int32_t value = samples[index];
      peak = max(peak, value < 0 ? -value : value);
    }
    Serial.printf("Cardputer PCM playback started (%u samples, peak=%d)\n",
                  playableBytes / sizeof(int16_t), peak);
  }

  bufferIndex_ = (bufferIndex_ + 1) % 3;
  bufferedBytes_ = 0;
  if (hasTrailingByte) {
    buffers_[bufferIndex_][0] = trailingByte;
    bufferedBytes_ = 1;
  }
}

void CardputerSpeakerOutput::flushAudio() {
  AudioLock lock;
  if (deviceState == SPEAKING && !faulted_ &&
      M5Cardputer.Speaker.isRunning()) {
    submitBuffer();
  }
}

void CardputerSpeakerOutput::discardAudio() {
  AudioLock lock;
  clearBuffer();
  if (M5Cardputer.Speaker.isRunning()) {
    M5Cardputer.Speaker.stop(0);
  }
}

bool CardputerSpeakerOutput::isPlaybackPending() {
  AudioLock lock;
  return bufferedBytes_ > 0 || M5Cardputer.Speaker.isPlaying();
}

void CardputerSpeakerOutput::clearBuffer() {
  bufferIndex_ = 0;
  bufferedBytes_ = 0;
  submittedBlocks_ = 0;
  faulted_ = false;
}

void setupCardputerHardware() {
  cardputerAudioMutex = xSemaphoreCreateMutex();

  auto config = M5.config();
  config.serial_baudrate = 0; // Serial is initialized by ElatoAI.
  config.internal_imu = false;
  config.internal_rtc = false;
  config.internal_mic = true;
  config.internal_spk = true;
  M5Cardputer.begin(config, true);

  M5Cardputer.Display.setRotation(1);
  M5Cardputer.Display.setBrightness(96);
  M5Cardputer.Display.setTextWrap(false);
  M5Cardputer.Display.fillScreen(TFT_BLACK);

  auto microphoneConfig = M5Cardputer.Mic.config();
  microphoneConfig.sample_rate = MIC_SAMPLE_RATE;
  M5Cardputer.Mic.config(microphoneConfig);

  // Software volume remains controlled by ElatoAI's VolumeStream. Keeping the
  // hardware mixer at full scale preserves the existing 0-100 volume behavior.
  M5Cardputer.Speaker.setVolume(255);

  // M5Cardputer.begin() leaves the speaker task marked as running before its
  // I2S port is usable on the original Cardputer. Tear that placeholder task
  // down once so the first speaking transition performs a clean begin().
  if (M5Cardputer.Speaker.isRunning()) {
    M5Cardputer.Speaker.end();
  }
  cardputerAudioMode = CardputerAudioMode::Idle;

  Serial.printf("Detected M5 board: %d\n", static_cast<int>(M5.getBoard()));
}

bool cardputerEnterSpeakerMode() {
  AudioLock lock;

  if (cardputerAudioMode == CardputerAudioMode::Microphone ||
      M5Cardputer.Mic.isRunning()) {
    waitForMicrophone();
    M5Cardputer.Mic.end();
  }
  cardputerSpeakerOutput.clearBuffer();

  if (!M5Cardputer.Speaker.isRunning() && !beginSpeakerWithRetry()) {
    Serial.println("Unable to start the Cardputer speaker");
    cardputerAudioMode = CardputerAudioMode::Idle;
    return false;
  }
  cardputerAudioMode = CardputerAudioMode::Speaker;
  return true;
}

bool cardputerEnterMicrophoneMode() {
  AudioLock lock;
  Serial.printf("Starting microphone (free=%u largest=%u)\n", ESP.getFreeHeap(),
                heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  if (cardputerAudioMode == CardputerAudioMode::Speaker ||
      M5Cardputer.Speaker.isRunning()) {
    cardputerSpeakerOutput.clearBuffer();
    M5Cardputer.Speaker.stop(0);
    M5Cardputer.Speaker.end();
  }
  if (!M5Cardputer.Mic.isRunning() && !beginMicrophoneWithRetry()) {
    Serial.println("Unable to start the Cardputer microphone");
    cardputerAudioMode = CardputerAudioMode::Idle;
    return false;
  }
  cardputerAudioMode = CardputerAudioMode::Microphone;
  Serial.printf("Microphone ready (free=%u largest=%u)\n", ESP.getFreeHeap(),
                heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  return true;
}

void stopCardputerAudio() {
  AudioLock lock;
  if (cardputerAudioMode == CardputerAudioMode::Microphone) {
    waitForMicrophone();
    M5Cardputer.Mic.end();
  } else if (cardputerAudioMode == CardputerAudioMode::Speaker) {
    cardputerSpeakerOutput.clearBuffer();
    M5Cardputer.Speaker.stop(0);
    M5Cardputer.Speaker.end();
  }
  cardputerAudioMode = CardputerAudioMode::Idle;
}

bool readCardputerMicrophone(int16_t *samples, size_t sampleCount) {
  if (samples == nullptr || sampleCount == 0) {
    return false;
  }

  AudioLock lock;
  if (deviceState != LISTENING ||
      cardputerAudioMode != CardputerAudioMode::Microphone) {
    return false;
  }

  if (!M5Cardputer.Mic.isRunning() && !M5Cardputer.Mic.begin()) {
    return false;
  }

  if (!M5Cardputer.Mic.record(samples, sampleCount, MIC_SAMPLE_RATE, false)) {
    return false;
  }

  // M5Unified records asynchronously. Waiting here gives the websocket task a
  // completed, stable 20 ms PCM block and bounds audio-mode handoff latency.
  waitForMicrophone();
  return deviceState == LISTENING;
}

void prepareCardputerForSleep() {
  M5Cardputer.Display.fillScreen(TFT_BLACK);
  M5Cardputer.Display.setTextDatum(middle_center);
  M5Cardputer.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5Cardputer.Display.drawString("Sleeping", M5Cardputer.Display.width() / 2,
                                 M5Cardputer.Display.height() / 2);

  // The same G0 button requests sleep and wakes the ESP32. Wait for release so
  // a held button does not wake the device immediately after deep sleep starts.
  while (digitalRead(GPIO_NUM_0) == LOW) {
    M5Cardputer.update();
    delay(10);
  }
  delay(100);
  M5Cardputer.Display.setBrightness(0);
}

#endif // ELATO_CARDPUTER

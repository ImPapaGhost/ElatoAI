#include "Cardputer.h"

#if defined(ELATO_CARDPUTER)

#include "Config.h"

namespace {

SemaphoreHandle_t cardputerAudioMutex = nullptr;

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

} // namespace

size_t CardputerSpeakerOutput::write(uint8_t value) {
  return write(&value, 1);
}

size_t CardputerSpeakerOutput::write(const uint8_t *data, size_t length) {
  if (data == nullptr || length == 0) {
    return 0;
  }

  AudioLock lock;
  if (deviceState != SPEAKING || !M5Cardputer.Speaker.isRunning()) {
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

  const bool accepted = M5Cardputer.Speaker.playRaw(
      reinterpret_cast<const int16_t *>(buffers_[bufferIndex_]),
      playableBytes / sizeof(int16_t), SAMPLE_RATE, false, 1, 0, false);

  if (!accepted) {
    Serial.println("Cardputer speaker queue rejected a PCM block");
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
  if (deviceState == SPEAKING && M5Cardputer.Speaker.isRunning()) {
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

void CardputerSpeakerOutput::clearBuffer() {
  bufferIndex_ = 0;
  bufferedBytes_ = 0;
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
  M5Cardputer.Mic.end();
  M5Cardputer.Speaker.end();

  Serial.printf("Detected M5 board: %d\n", static_cast<int>(M5.getBoard()));
}

void cardputerEnterSpeakerMode() {
  AudioLock lock;

  waitForMicrophone();
  M5Cardputer.Mic.end();
  cardputerSpeakerOutput.clearBuffer();
  M5Cardputer.Speaker.stop(0);

  if (!M5Cardputer.Speaker.isRunning() && !M5Cardputer.Speaker.begin()) {
    Serial.println("Unable to start the Cardputer speaker");
  }
}

void cardputerEnterMicrophoneMode() {
  cardputerSpeakerOutput.discardAudio();

  AudioLock lock;
  M5Cardputer.Speaker.end();
  if (!M5Cardputer.Mic.isRunning() && !M5Cardputer.Mic.begin()) {
    Serial.println("Unable to start the Cardputer microphone");
  }
}

void stopCardputerAudio() {
  cardputerSpeakerOutput.discardAudio();

  AudioLock lock;
  waitForMicrophone();
  M5Cardputer.Mic.end();
  M5Cardputer.Speaker.end();
}

bool readCardputerMicrophone(int16_t *samples, size_t sampleCount) {
  if (samples == nullptr || sampleCount == 0) {
    return false;
  }

  AudioLock lock;
  if (deviceState != LISTENING) {
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

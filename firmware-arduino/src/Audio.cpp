#include "OTA.h"
#include "Audio.h"
#include "Cardputer.h"
#include "PitchShift.h"

// WEBSOCKET
SemaphoreHandle_t wsMutex;
WebSocketsClient webSocket;

#if defined(INDEPENDENT_MODE)
static uint8_t privateReconnectAttempts = 0;
#endif

// TASK HANDLES
TaskHandle_t speakerTaskHandle = NULL;
TaskHandle_t micTaskHandle = NULL;
TaskHandle_t networkTaskHandle = NULL;

// TIMING REGISTERS
volatile bool scheduleListeningRestart = false;
unsigned long scheduledTime = 0;
volatile unsigned long speakingStartTime = 0;
volatile unsigned long lastResponseActivityTime = 0;

#if defined(ELATO_CARDPUTER)
unsigned long responseDrainDeadline = 0;
uint32_t responseOpusPackets = 0;
uint32_t responseOpusBytes = 0;
uint32_t responsePcmBytes = 0;
#endif

// AUDIO SETTINGS
int currentVolume = 70;
float currentPitchFactor = 1.0f;
const int CHANNELS = 1;         // Mono
const int BITS_PER_SAMPLE = 16; // 16-bit audio

// AUDIO OUTPUT
class BufferPrint : public Print {
public:
  explicit BufferPrint(BufferRTOS<uint8_t>& buf) : _buffer(buf) {}

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(uint8_t data) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        const size_t written = _buffer.writeArray(&data, 1);
#if defined(ELATO_CARDPUTER)
        responsePcmBytes += written;
#endif
        return written;
    }
    return 1; //let opusDecoder write, otherwise thread will stuck
  }

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(const uint8_t *buffer, size_t size) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        const size_t written = _buffer.writeArray(buffer, size);
#if defined(ELATO_CARDPUTER)
        responsePcmBytes += written;
#endif
        return written;
    }
    return size; //let opusDecoder write, otherwise thread will stuck
  }

private:
  BufferRTOS<uint8_t>& _buffer;
};

BufferPrint bufferPrint(audioBuffer);
ResettableOpusAudioDecoder opusDecoder;  //access guarded by wsmutex
BufferRTOS<uint8_t> audioBuffer(AUDIO_BUFFER_SIZE, AUDIO_CHUNK_SIZE);  //producer: networkTask, consumer: audioStreamTask. Thread safe in single producer->single consumer scenario.
QueueStream<uint8_t> queue(audioBuffer); //access from audioStreamTask only

#if defined(ELATO_CARDPUTER)
CardputerSpeakerOutput cardputerSpeakerOutput;
VolumeStream volume(cardputerSpeakerOutput); //access from audioStreamTask only
PitchShiftFixedOutput pitchShift(cardputerSpeakerOutput);
#else
I2SStream i2s; //access from audioStreamTask only
VolumeStream volume(i2s); //access from audioStreamTask only
PitchShiftFixedOutput pitchShift(i2s);
#endif

// Standard and pitch-shifted output paths share the selected hardware sink.
StreamCopy copier(volume, queue);
VolumeStream volumePitch(pitchShift); //access from audioStreamTask only
StreamCopy pitchCopier(volumePitch, queue);

AudioInfo info(SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE);
volatile bool i2sOutputFlushScheduled = false;

unsigned long getSpeakingDuration() {
    const unsigned long started = speakingStartTime;
    const unsigned long now = millis();
    if (deviceState == SPEAKING && started > 0 &&
        static_cast<int32_t>(now - started) >= 0) {
        return now - started;
    }
    return 0;
}

unsigned long getResponseInactivityDuration() {
    const unsigned long lastActivity = lastResponseActivityTime;
    const unsigned long now = millis();
    if (deviceState == SPEAKING && lastActivity > 0 &&
        static_cast<int32_t>(now - lastActivity) >= 0) {
        return now - lastActivity;
    }
    return 0;
}

// networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> transitionToSpeaking()
void transitionToSpeaking() {
    // Clear a prior turn before yielding. A late RESPONSE.CREATED can otherwise
    // leave the watchdog observing the previous SPEAKING timestamp during this
    // handoff delay.
    deviceState = PROCESSING;
    speakingStartTime = 0;
    vTaskDelay(50);

    i2sInputFlushScheduled = true;

#if defined(ELATO_CARDPUTER)
    if (!cardputerEnterSpeakerMode()) {
        deviceState = WAITING;
        return;
    }
#else
    digitalWrite(I2S_SD_OUT, HIGH);
#endif

    speakingStartTime = millis();
    lastResponseActivityTime = speakingStartTime;
    deviceState = SPEAKING;
    
    // webSocket.enableHeartbeat(30000, 15000, 3);
    
    Serial.println("Transitioned to speaking mode");
}

// networkTask -> transitionToListening()
// ( networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> (sets scheduleListeningRestart) -> networkTask -> transitionToListening() )
void transitionToListening() {
    if (!webSocket.isConnected()) {
        scheduleListeningRestart = false;
        deviceState = IDLE;
        Serial.println("Cannot enter listening mode without a websocket connection");
        return;
    }

    deviceState = PROCESSING;   
    scheduleListeningRestart = false;
    Serial.println("Transitioning to listening mode");

    i2sInputFlushScheduled = true;
    i2sOutputFlushScheduled = true;

#if defined(ELATO_CARDPUTER)
    if (!cardputerEnterMicrophoneMode()) {
        deviceState = WAITING;
        return;
    }
#else
    digitalWrite(I2S_SD_OUT, LOW);
#endif

    Serial.println("Transitioned to listening mode");

    deviceState = LISTENING;
    speakingStartTime = 0;
    lastResponseActivityTime = 0;
    // webSocket.disableHeartbeat();
}

// audioStreamTask -> copier.copy() (conditional on webSocket.isConnected())
void audioStreamTask(void *parameter) {
    Serial.println("Starting I2S stream pipeline...");

#if !defined(ELATO_CARDPUTER)
    pinMode(I2S_SD_OUT, OUTPUT);
#endif

    OpusSettings cfg;
    cfg.sample_rate = SAMPLE_RATE;
    cfg.channels = CHANNELS;
    cfg.bits_per_sample = BITS_PER_SAMPLE;
    // A 120ms Opus frame decoded at 48kHz mono s16 is 11520 bytes; 6144 only
    // fit the old 24kHz pipeline.
    cfg.max_buffer_size = 12288;

    xSemaphoreTake(wsMutex, portMAX_DELAY);
    opusDecoder.setOutput(bufferPrint);
    opusDecoder.begin(cfg);
    xSemaphoreGive(wsMutex);

    audioBuffer.setReadMaxWait(0);
    
    queue.begin();

#if !defined(ELATO_CARDPUTER)
    auto config = i2s.defaultConfig(TX_MODE);
    config.bits_per_sample = BITS_PER_SAMPLE;
    config.sample_rate = SAMPLE_RATE;
    config.channels = CHANNELS;
    config.pin_bck = I2S_BCK_OUT;
    config.pin_ws = I2S_WS_OUT;
    config.pin_data = I2S_DATA_OUT;
    config.port_no = I2S_PORT_OUT;

    config.copyFrom(info);  
    i2s.begin(config);  
#endif

    // Initialize both volume streams once
    auto vcfg = volume.defaultConfig();
    vcfg.copyFrom(info);
    vcfg.allow_boost = true;
    volume.begin(vcfg);
    
    auto vcfgPitch = volumePitch.defaultConfig();
    vcfgPitch.copyFrom(info);
    vcfgPitch.allow_boost = true;
    volumePitch.begin(vcfgPitch);

    while (1) {
        if ( i2sOutputFlushScheduled) {
            i2sOutputFlushScheduled = false;
#if defined(ELATO_CARDPUTER)
            cardputerSpeakerOutput.discardAudio();
#else
            i2s.flush();
#endif
            volume.flush();
            volumePitch.flush();
            queue.flush();
        }

        if (webSocket.isConnected() && deviceState == SPEAKING) {
            if (currentPitchFactor != 1.0f) {
                pitchCopier.copy();
            } else {
                copier.copy();
            }
        }
        else {
            //we should always read from audioBuffer, otherwise writing thread can stuck
            queue.read();
        }
        vTaskDelay(1); 
    }
}


class WebsocketStream : public Print {
public:
    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(uint8_t b) override {
        if (!webSocket.isConnected() || deviceState != LISTENING) {
            return 1;
        }
        
        xSemaphoreTake(wsMutex, portMAX_DELAY);
        webSocket.sendBIN(&b, 1);
        xSemaphoreGive(wsMutex);
        return 1;
    }
    
    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(const uint8_t *buffer, size_t size) override {
        if (size == 0 || !webSocket.isConnected() || deviceState != LISTENING) {
            return size;
        }
        
        xSemaphoreTake(wsMutex, portMAX_DELAY);
        webSocket.sendBIN(buffer, size);
        xSemaphoreGive(wsMutex);
        return size;
    }
};

WebsocketStream wsStream; //guard with wsMutex
#if !defined(ELATO_CARDPUTER)
I2SStream i2sInput; //access from micTask only
StreamCopy micToWsCopier(wsStream, i2sInput);
#endif
volatile bool i2sInputFlushScheduled = false;
const int MIC_COPY_SIZE = 64;

void micTask(void *parameter) {
#if defined(ELATO_CARDPUTER)
    // 20 ms of mono PCM at 16 kHz. This is large enough for efficient websocket
    // frames while keeping mic/speaker handoff latency bounded.
    constexpr size_t MIC_FRAME_SAMPLES = 320; // 20 ms at 16 kHz
    int16_t micFrame[MIC_FRAME_SAMPLES];

    while (1) {
        if (i2sInputFlushScheduled) {
            i2sInputFlushScheduled = false;
            memset(micFrame, 0, sizeof(micFrame));
        }

        if (deviceState == LISTENING && webSocket.isConnected() &&
            readCardputerMicrophone(micFrame, MIC_FRAME_SAMPLES)) {
            wsStream.write(reinterpret_cast<const uint8_t *>(micFrame),
                           sizeof(micFrame));
        } else {
            vTaskDelay(5);
        }
    }
#else
    // Configure and start I2S input stream.
    auto i2sConfig = i2sInput.defaultConfig(RX_MODE);
    i2sConfig.bits_per_sample = BITS_PER_SAMPLE;
    i2sConfig.sample_rate = MIC_SAMPLE_RATE;
    i2sConfig.channels = CHANNELS;
    i2sConfig.i2s_format = I2S_LEFT_JUSTIFIED_FORMAT;
    i2sConfig.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    // Configure your I2S input pins appropriately here:
    i2sConfig.pin_bck = I2S_SCK;
    i2sConfig.pin_ws  = I2S_WS;
    i2sConfig.pin_data = I2S_SD;
    i2sConfig.port_no = I2S_PORT_IN;
    i2sInput.begin(i2sConfig);

    micToWsCopier.setDelayOnNoData(0);

    while (1) {
        if (i2sInputFlushScheduled) {
            i2sInputFlushScheduled = false;
            i2sInput.flush();
        }

        if (deviceState == LISTENING && webSocket.isConnected()) {
            // Use smaller chunk size to avoid blocking too long
            micToWsCopier.copyBytes(MIC_COPY_SIZE);
            
            // Yield more frequently
            vTaskDelay(1);
        } else {
            vTaskDelay(10);
        }
    }
#endif
}

void shutdownAudioHardware() {
#if defined(ELATO_CARDPUTER)
    stopCardputerAudio();
#else
    i2s_stop(I2S_PORT_IN);
    i2s_stop(I2S_PORT_OUT);
    i2s_driver_uninstall(I2S_PORT_IN);
    i2s_driver_uninstall(I2S_PORT_OUT);
#endif
}

// WEBSOCKET EVENTS
// networkTask -> webSocket.loop() -> webSocketEvent()
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length)
{
    switch (type)
    {
    case WStype_DISCONNECTED:
        Serial.printf("[WSc] Disconnected!\n");
#if defined(INDEPENDENT_MODE)
        {
        // A used-up daily allowance should not poll the free backend every
        // five seconds indefinitely. A successful handshake resets the delay.
        if (privateReconnectAttempts < 7) ++privateReconnectAttempts;
        const unsigned long retryMs =
            min(300000UL, 5000UL << (privateReconnectAttempts - 1));
        webSocket.setReconnectInterval(retryMs);
        Serial.printf("Private server retry in %lu seconds\n", retryMs / 1000);
        }
#endif
        scheduleListeningRestart = false;
        speakingStartTime = 0;
        lastResponseActivityTime = 0;
        deviceState = IDLE;
#if defined(ELATO_CARDPUTER)
        responseDrainDeadline = 0;
        i2sInputFlushScheduled = true;
        i2sOutputFlushScheduled = true;
        stopCardputerAudio();
#endif
        break;
    case WStype_CONNECTED:
        Serial.printf("[WSc] Connected to url: %s\n", payload);
#if defined(INDEPENDENT_MODE)
        privateReconnectAttempts = 0;
        webSocket.setReconnectInterval(5000);
#endif
        opusDecoder.resetState();
        speakingStartTime = 0;
        lastResponseActivityTime = 0;
        deviceState = WAITING;
        break;
    case WStype_TEXT:
    {
        Serial.printf("[WSc] get text: %s\n", payload);

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (char *)payload);

        if (error)
        {
            Serial.println("Error deserializing JSON");
            deviceState = IDLE;
            return;
        }

        String type = doc["type"];

        // auth messages
        if (strcmp((char*)type.c_str(), "auth") == 0) {
            deviceState = WAITING;
            currentVolume = doc["volume_control"].as<int>();
            currentPitchFactor = doc["pitch_factor"].as<float>();

            bool is_ota = doc["is_ota"].as<bool>();
            bool is_reset = doc["is_reset"].as<bool>();

            // Update volumes on both streams
            volume.setVolume(currentVolume / 100.0f);
            volumePitch.setVolume(currentVolume / 100.0f);
            
            // Only initialize pitch shift if needed
            if (currentPitchFactor != 1.0f) {
                auto pcfg = pitchShift.defaultConfig();
                pcfg.copyFrom(info);
                pcfg.pitch_shift = currentPitchFactor;
                pcfg.buffer_size = 512;
                pitchShift.begin(pcfg);
            }

            if (is_ota) {
                Serial.println("OTA update received");
                setOTAStatusInNVS(OTA_IN_PROGRESS);
                ESP.restart();
            }

            if (is_reset) {
                Serial.println("Factory reset received");
                // setFactoryResetStatusInNVS(true);
                ESP.restart();
            }
        }

        // oai messages
        if (strcmp((char*)type.c_str(), "server") == 0) {
            String msg = doc["msg"];
            Serial.println(msg);

            if (strcmp((char*)msg.c_str(), "RESPONSE.COMPLETE") == 0) {
                Serial.println("Received RESPONSE.COMPLETE, draining speaker audio");

                // Disarm the speaking watchdog immediately. A completion that
                // arrives at the timeout boundary must win over recovery.
                speakingStartTime = 0;
                lastResponseActivityTime = 0;
#if defined(ELATO_CARDPUTER)
                Serial.printf("Response audio: %u Opus packets / %u bytes -> %u PCM bytes\n",
                              responseOpusPackets, responseOpusBytes,
                              responsePcmBytes);
#endif

                // Check if volume_control is included in the message
                if (doc["volume_control"].is<int>()) {
                    int newVolume = doc["volume_control"].as<int>();
                    volume.setVolume(newVolume / 100.0f);
                }

                scheduleListeningRestart = true;
                scheduledTime = millis() + 20;
#if defined(ELATO_CARDPUTER)
                // A bounded drain avoids clipping queued speech while still
                // recovering if the M5 speaker task itself stops advancing.
                responseDrainDeadline = millis() + 10000;
#endif
            } else if (strcmp((char*)msg.c_str(), "RESPONSE.ERROR") == 0) {
                Serial.println("Voice server reported RESPONSE.ERROR");
                scheduleListeningRestart = false;
                speakingStartTime = 0;
                lastResponseActivityTime = 0;
                i2sInputFlushScheduled = true;
                i2sOutputFlushScheduled = true;
                deviceState = WAITING;
            } else if (strcmp((char*)msg.c_str(), "AUDIO.COMMITTED") == 0) {
                deviceState = PROCESSING; 
            } else if (strcmp((char*)msg.c_str(), "RESPONSE.CREATED") == 0) {
                Serial.println("Received RESPONSE.CREATED, transitioning to speaking");
#if defined(ELATO_CARDPUTER)
                responseOpusPackets = 0;
                responseOpusBytes = 0;
                responsePcmBytes = 0;
                responseDrainDeadline = 0;
#endif
                opusDecoder.resetState();
                transitionToSpeaking();
            } else if (strcmp((char*)msg.c_str(), "SESSION.END") == 0) {
                Serial.println("Received SESSION.END, going to sleep");
                sleepRequested = true;
            }
        }
    }
        break;
    case WStype_BIN:
    {
        if (scheduleListeningRestart || deviceState != SPEAKING) {
            Serial.println("Skipping audio data due to touch interrupt.");
            break;
        }

        // Otherwise process the audio data normally
        const int packetSamples =
            opus_packet_get_nb_samples(payload, length, SAMPLE_RATE);
        if (length == 0 || length > 1275 || packetSamples <= 0 ||
            packetSamples > 5760) {
            Serial.printf("Dropping invalid Opus packet (%u bytes, samples=%d)\n",
                          length, packetSamples);
            break;
        }
#if defined(ELATO_CARDPUTER)
        ++responseOpusPackets;
        responseOpusBytes += length;
#endif
        lastResponseActivityTime = millis();
        size_t processed = opusDecoder.write(payload, length);
        if (processed != length) {
            Serial.printf("Warning: Only processed %d/%d bytes\n", processed, length);
        }
        break;
      }
    case WStype_ERROR:
        Serial.printf("[WSc] Error: %s\n", payload);    
        break;
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_PONG:
    case WStype_PING:
    case WStype_FRAGMENT_FIN:
        break;
    }
}

// wifiTask -> WIFIMANAGER::loop() -> WIFIMANAGER::tryConnect() -> connectCb() -> websocketSetup()
void websocketSetup(const String& server_domain, int port, const String& path)
{
    const String headers =
        "Authorization: Bearer " + String(authTokenGlobal) + "\r\n" +
        "X-Wifi-Rssi: " + String(WiFi.RSSI()) + "\r\n" +
        "X-Device-Mac: " + WiFi.macAddress();

    xSemaphoreTake(wsMutex, portMAX_DELAY);

    webSocket.setExtraHeaders(headers.c_str());
    webSocket.onEvent(webSocketEvent);
#if defined(ELATO_CARDPUTER)
    webSocket.setReconnectInterval(5000);
#else
    webSocket.setReconnectInterval(1000);
#endif
    webSocket.disableHeartbeat();

    // webSocket.enableHeartbeat(30000, 15000, 3); // 30s ping interval, 15s timeout, 3 retries

    #ifdef DEV_MODE
    webSocket.begin(server_domain.c_str(), port, path.c_str());
    #else
    webSocket.beginSslWithCA(server_domain.c_str(), port, path.c_str(), CA_cert);
    #endif

    xSemaphoreGive(wsMutex);
}

// networkTask -> webSocket.loop()
void networkTask(void *parameter) {
    while (1) {
        xSemaphoreTake(wsMutex, portMAX_DELAY);

        // Check to see if a transition to listening mode is scheduled.
        if (scheduleListeningRestart && millis() >= scheduledTime) {
#if defined(ELATO_CARDPUTER)
            bool playbackDrained = audioBuffer.isEmpty();
            if (playbackDrained) {
                cardputerSpeakerOutput.flushAudio();
                playbackDrained = !cardputerSpeakerOutput.isPlaybackPending();
            }

            const bool drainTimedOut =
                static_cast<int32_t>(millis() - responseDrainDeadline) >= 0;
            if (playbackDrained || drainTimedOut) {
                if (drainTimedOut && !playbackDrained) {
                    Serial.println("Cardputer speaker drain timed out");
                }
                transitionToListening();
            } else {
                scheduledTime = millis() + 20;
            }
#else
            transitionToListening();
#endif
        }

        webSocket.loop();
        xSemaphoreGive(wsMutex);

        vTaskDelay(1);
    }
}

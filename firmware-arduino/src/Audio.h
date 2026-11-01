#ifndef AUDIO_H
#define AUDIO_H

#include "AudioTools.h"
#include "AudioTools/AudioCodecs/CodecOpus.h"
#include "Config.h"

extern SemaphoreHandle_t wsMutex;
extern WebSocketsClient webSocket;

extern TaskHandle_t speakerTaskHandle;
extern TaskHandle_t micTaskHandle;
extern TaskHandle_t networkTaskHandle;

extern volatile bool scheduleListeningRestart;
extern unsigned long scheduledTime;
extern volatile unsigned long speakingStartTime;
extern volatile unsigned long lastResponseActivityTime;

extern int currentVolume;
extern const int CHANNELS;         // Mono
extern const int BITS_PER_SAMPLE; // 16-bit audio

// AUDIO OUTPUT
#if defined(ELATO_CARDPUTER)
// A maximum-duration Opus frame expands to 11,520 bytes of mono s16 PCM at
// 48 kHz. The decoder emits it in 512-byte writes, and 12 KiB keeps one full
// frame buffered without competing with libopus's large scratch workspace.
constexpr size_t AUDIO_BUFFER_SIZE = 1024 * 12;
#else
constexpr size_t AUDIO_BUFFER_SIZE = 1024 * 10;
#endif
constexpr size_t AUDIO_CHUNK_SIZE  = 1024;         // ideal read/write chunk size

class ResettableOpusAudioDecoder : public OpusAudioDecoder {
public:
    bool resetState() {
        return dec != nullptr && opus_decoder_ctl(dec, OPUS_RESET_STATE) == OPUS_OK;
    }
};

extern ResettableOpusAudioDecoder opusDecoder;
extern BufferRTOS<uint8_t> audioBuffer;
#if !defined(ELATO_CARDPUTER)
extern I2SStream i2s; 
#endif
extern VolumeStream volume;
extern QueueStream<uint8_t> queue;
extern StreamCopy copier;

// NEW for pitch shift
extern VolumeStream volumePitch;
extern StreamCopy pitchCopier;

extern AudioInfo info;
extern volatile bool i2sOutputFlushScheduled;

// AUDIO INPUT
#if !defined(ELATO_CARDPUTER)
extern I2SStream i2sInput;
extern StreamCopy micToWsCopier;
#endif
extern volatile bool i2sInputFlushScheduled;

// WEBSOCKET
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length);
void websocketSetup(const String& server_domain, int port, const String& path);
void networkTask(void *parameter);

// AUDIO OUTPUT
unsigned long getSpeakingDuration();
unsigned long getResponseInactivityDuration();
void audioStreamTask(void *parameter);

// AUDIO INPUT
void micTask(void *parameter);
void shutdownAudioHardware();
#if defined(EASY_SETUP_MODE)
bool cardputerProviderConnectionFailed();
bool cardputerVoiceInStandby();
// UI only requests a wake; the network task owns voice disconnect/reconnect.
void requestCardputerVoiceWake();
#endif

#endif

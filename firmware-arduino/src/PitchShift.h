#ifndef PITCHSHIFT_H
#define PITCHSHIFT_H

#include "AudioTools.h"

//pitch shift effect with interpolaion fixed to 1.5 frequency factor, fixed delay, int16_t, 1 channel
class PitchShiftFixedOutput : public AudioOutput {
public:
  explicit PitchShiftFixedOutput(Print &out) { p_out = &out; }

  PitchShiftInfo defaultConfig() {
    PitchShiftInfo result;
    result.bits_per_sample = sizeof(int16_t) * 8;
    return result;
  }

  bool begin(PitchShiftInfo info);

  size_t write(const uint8_t *data, size_t len) override {
    size_t result = 0;
    const int16_t *p_in = reinterpret_cast<const int16_t *>(data);
    const size_t sample_count = len / sizeof(int16_t);
    constexpr size_t OUTPUT_SAMPLES = 128;
    int16_t output[OUTPUT_SAMPLES];

    for (size_t offset = 0; offset < sample_count; offset += OUTPUT_SAMPLES) {
      const size_t count = min(OUTPUT_SAMPLES, sample_count - offset);
      for (size_t index = 0; index < count; ++index) {
        output[index] = pitchShift(p_in[offset + index]);
      }
      result += p_out->write(reinterpret_cast<const uint8_t *>(output),
                             count * sizeof(int16_t));
    }
    return result;
  }

  void end() {}

protected:
  Print *p_out = nullptr;

  int16_t pitchShift(int16_t value);
  uint32_t pitchMul;
  unsigned long secondaryOffset;
};

#endif

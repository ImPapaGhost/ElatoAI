#include "LEDHandler.h"

#if defined(ELATO_CARDPUTER)

#include "Cardputer.h"
#include <WiFi.h>

namespace {

struct StatePresentation {
    const char *label;
    const char *hint;
    uint16_t color;
    uint16_t textColor;
};

StatePresentation presentationFor(DeviceState state)
{
    switch (state)
    {
    case SOFT_AP:
        return {"SET UP WI-FI", "Join ELATO-DEVICE", TFT_MAGENTA, TFT_WHITE};
    case LISTENING:
        return {"LISTENING", "Speak naturally", TFT_YELLOW, TFT_BLACK};
    case PROCESSING:
        return {"THINKING", "Waiting for the agent", TFT_ORANGE, TFT_BLACK};
    case SPEAKING:
        return {"SPEAKING", "Playing the response", TFT_CYAN, TFT_BLACK};
    case OTA:
        return {"UPDATING", "Keep power connected", TFT_BLUE, TFT_WHITE};
    case FACTORY_RESET:
        return {"RESETTING", "Restoring defaults", TFT_RED, TFT_WHITE};
    case SLEEP:
        return {"SLEEPING", "Press G0 to wake", TFT_DARKGREY, TFT_WHITE};
    case SETUP:
        return {"STARTING", "Initializing hardware", TFT_PURPLE, TFT_WHITE};
    case WAITING:
        return {"WAITING", "Connected", TFT_NAVY, TFT_WHITE};
    case IDLE:
    default:
        return {"READY", "Connecting to ElatoAI", TFT_GREEN, TFT_BLACK};
    }
}

void drawCardputerStatus(DeviceState state)
{
    const StatePresentation view = presentationFor(state);
    auto &display = M5Cardputer.Display;
    const int width = display.width();

    display.startWrite();
    display.fillScreen(TFT_BLACK);

    display.fillRect(0, 0, width, 24, TFT_DARKCYAN);
    display.setTextDatum(middle_left);
    display.setTextSize(1);
    display.setTextColor(TFT_WHITE, TFT_DARKCYAN);
    display.drawString("ELATO AI", 8, 12);

    const int battery = M5Cardputer.Power.getBatteryLevel();
    if (battery >= 0)
    {
        display.setTextDatum(middle_right);
        display.drawString(String(battery) + "%", width - 8, 12);
    }

    display.fillRoundRect(8, 31, width - 16, 43, 7, view.color);
    display.setTextDatum(middle_center);
    display.setTextSize(2);
    display.setTextColor(view.textColor, view.color);
    display.drawString(view.label, width / 2, 52);

    display.setTextSize(1);
    display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    display.drawString(view.hint, width / 2, 84);

    display.setTextDatum(top_center);
    if (state == SOFT_AP)
    {
        display.setTextColor(TFT_WHITE, TFT_BLACK);
        display.drawString("Open 192.168.4.1/wifi", width / 2, 97);
    }
    else if (WiFi.status() == WL_CONNECTED)
    {
        display.setTextColor(TFT_GREENYELLOW, TFT_BLACK);
        display.drawString(WiFi.SSID(), width / 2, 97);
        display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
        display.drawString(WiFi.localIP().toString(), width / 2, 109);
    }
    else
    {
        display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
        display.drawString("Connecting to Wi-Fi...", width / 2, 103);
    }

    display.setTextDatum(bottom_center);
    display.setTextColor(TFT_DARKGREY, TFT_BLACK);
    display.drawString("Hold G0 to sleep", width / 2, display.height() - 2);
    display.endWrite();
}

} // namespace

void setLEDColor(uint8_t, uint8_t, uint8_t) {}
void turnOffLED() {}
void turnOnLED() {}
void setupRGBLED() {}
void turnOnBlueLED() {}
void turnOnRedLEDFlash() {}

void ledTask(void *parameter)
{
    (void)parameter;
    DeviceState lastState = static_cast<DeviceState>(-1);
    unsigned long lastRefresh = 0;

    while (1)
    {
        M5Cardputer.update();
        if (M5Cardputer.BtnA.wasHold())
        {
            sleepRequested = true;
        }

        const DeviceState currentState = deviceState;
        const unsigned long now = millis();
        if (currentState != lastState || now - lastRefresh >= 1000)
        {
            drawCardputerStatus(currentState);
            lastState = currentState;
            lastRefresh = now;
        }

        vTaskDelay(20 / portTICK_PERIOD_MS);
    }
}

#else

int brightness = 0;
int fadeAmount = 5;
static unsigned long lastToggle = 0;
static bool ledState = false;

void setLEDColor(uint8_t r, uint8_t g, uint8_t b)
{
    analogWrite(RED_LED_PIN, r);
    analogWrite(GREEN_LED_PIN, g);
    analogWrite(BLUE_LED_PIN, b);
}

enum class StaticColor : uint8_t
{
    RED,
    GREEN,
    BLUE,
    YELLOW,
    MAGENTA,
    CYAN,
};

struct RGB {
    bool red;
    bool green;
    bool blue;
};

void setStaticColor(StaticColor color)
{
    RGB colorMap;

    switch (color)
    {
    case StaticColor::RED:
        colorMap = {LOW, HIGH, HIGH};
        break;
    case StaticColor::GREEN:
        colorMap = {HIGH, LOW, HIGH};
        break;
    case StaticColor::BLUE:
        colorMap = {HIGH, HIGH, LOW};
        break;
    case StaticColor::YELLOW:
        colorMap = {LOW, LOW, HIGH};
        break;
    case StaticColor::MAGENTA:
        colorMap = {LOW, HIGH, LOW};
        break;
    case StaticColor::CYAN:
        colorMap = {HIGH, LOW, LOW};
        break;
    default:
        colorMap = {HIGH, HIGH, HIGH};
        break;
    }

    digitalWrite(RED_LED_PIN, colorMap.red);
    digitalWrite(GREEN_LED_PIN, colorMap.green);
    digitalWrite(BLUE_LED_PIN, colorMap.blue);
}

void loopCyanPinkYellow()
{
    // Cyan (Green + Blue)
    digitalWrite(RED_LED_PIN, LOW);
    digitalWrite(GREEN_LED_PIN, HIGH);
    digitalWrite(BLUE_LED_PIN, HIGH);
    delay(500);

    // Pink (Red + Blue)
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(BLUE_LED_PIN, HIGH);
    delay(500);

    // Yellow (Red + Green)
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(GREEN_LED_PIN, HIGH);
    digitalWrite(BLUE_LED_PIN, LOW);
    delay(500);
}

void pulseWhite()
{
    setLEDColor(brightness, brightness, brightness);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void pulseMagenta()
{
    setLEDColor(brightness, 0, brightness);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void pulseYellow()
{
    setLEDColor(brightness, brightness, 0);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void pulseBlue()
{
    setLEDColor(0, 0, brightness);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void blinkWhite()
{
    int out = ledState ? HIGH : LOW;
    digitalWrite(RED_LED_PIN, out);
    digitalWrite(GREEN_LED_PIN, out);
    digitalWrite(BLUE_LED_PIN, out);
}

void blinkGreen()
{
    int out = ledState ? HIGH : LOW;
    digitalWrite(BLUE_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, LOW);   
    digitalWrite(GREEN_LED_PIN, out);    
}

void blinkYellow()
{
    int out = ledState ? HIGH : LOW;
    digitalWrite(BLUE_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, out);
    digitalWrite(GREEN_LED_PIN, out);    
}

void turnOffLED()
{
    digitalWrite(RED_LED_PIN, LOW);
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(BLUE_LED_PIN, LOW);
}

void turnOnLED()
{
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(GREEN_LED_PIN, HIGH);
    digitalWrite(BLUE_LED_PIN, HIGH);
}

void setupRGBLED()
{
    pinMode(RED_LED_PIN, OUTPUT);
    pinMode(GREEN_LED_PIN, OUTPUT);
    pinMode(BLUE_LED_PIN, OUTPUT);
    turnOffLED(); // Turn off the LED initially
}

void blinkCyanPulse()
{
    analogWrite(GREEN_LED_PIN, brightness);
    analogWrite(BLUE_LED_PIN, brightness);

    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255)
    {
        fadeAmount = -fadeAmount;
    }
}


void blinkBlue()
{
    int out = ledState ? HIGH : LOW;
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, LOW);   
    digitalWrite(BLUE_LED_PIN, out); 
}

void staticYellow()
{
    digitalWrite(BLUE_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(GREEN_LED_PIN, HIGH);
}

static const uint8_t colorSequence[][3] = {
    {0, 255, 255}, // Cyan   (R=0,   G=255, B=255)
    {255, 0, 255}, // Pink   (R=255, G=0,   B=255)
    {255, 255, 0}, // Yellow (R=255, G=255, B=0)
};

static const int NUM_COLORS = sizeof(colorSequence) / sizeof(colorSequence[0]);

void loopCyanPinkYellowPulse(unsigned long currentTime)
{
    // Duration of each color fade
    const unsigned long transitionDuration = 1000; // 500 ms per fade

    // colorIndex = which color in colorSequence we’re currently *starting* from
    static int colorIndex = 0;

    // We'll store the "start color" and "end color" for the current fade
    static uint8_t startColor[3];
    static uint8_t endColor[3];

    // The timestamp at which the current fade *started*
    static unsigned long transitionStartTime = 0;

    // A flag so we can initialize the first fade
    static bool initialized = false;

    if (!initialized)
    {
        // On the very first call, set the starting color to colorSequence[0]
        // and the endColor to the next color in the array
        memcpy(startColor, colorSequence[colorIndex], 3);
        int nextIndex = (colorIndex + 1) % NUM_COLORS;
        memcpy(endColor, colorSequence[nextIndex], 3);

        transitionStartTime = currentTime;
        initialized = true;
    }

    // How long has this transition been running?
    unsigned long elapsed = currentTime - transitionStartTime;
    float t = (float)elapsed / (float)transitionDuration;
    if (t > 1.0f)
    {
        t = 1.0f; // clamp
    }

    // Interpolate each channel: R, G, B
    uint8_t r = startColor[0] + (endColor[0] - startColor[0]) * t;
    uint8_t g = startColor[1] + (endColor[1] - startColor[1]) * t;
    uint8_t b = startColor[2] + (endColor[2] - startColor[2]) * t;

    // Write these values to your LED pins
    analogWrite(RED_LED_PIN, r);
    analogWrite(GREEN_LED_PIN, g);
    analogWrite(BLUE_LED_PIN, b);

    // Check if this transition has finished
    if (elapsed >= transitionDuration)
    {
        // Move to next color in the sequence
        colorIndex = (colorIndex + 1) % NUM_COLORS;
        memcpy(startColor, endColor, 3); // old 'end' becomes new 'start'

        int nextIndex = (colorIndex + 1) % NUM_COLORS;
        memcpy(endColor, colorSequence[nextIndex], 3);

        transitionStartTime = currentTime; // reset the clock for the next fade
    }
}

void ledTask(void *parameter)
{
    setupRGBLED();
    unsigned long currentTime = 0;
    while (1)
    {
        currentTime += 20; // Track time based on vTaskDelay

        // Toggle LED state every 200ms for blinking functions
        if (currentTime - lastToggle >= 200)
        {
            ledState = !ledState;
            lastToggle = currentTime;
        }

        switch (deviceState)
        {
        case IDLE:
            setStaticColor(StaticColor::GREEN);
            break;
        case SOFT_AP:
            setStaticColor(StaticColor::MAGENTA);
            break;
        case PROCESSING:
            setStaticColor(StaticColor::RED);
            break;
        case SPEAKING:
            setStaticColor(StaticColor::BLUE);
            break;
        case LISTENING:
            setStaticColor(StaticColor::YELLOW);
            break;
        case OTA:
            setStaticColor(StaticColor::CYAN);
            break;
        default:
            setStaticColor(StaticColor::GREEN); // LED on
            break;
        }

        // Delay for smoother LED transitions
        vTaskDelay(20 / portTICK_PERIOD_MS); // Approximate the delay from the original `pulsateLED()`
    }
}

#endif // ELATO_CARDPUTER

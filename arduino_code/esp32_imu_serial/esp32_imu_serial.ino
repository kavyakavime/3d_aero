/*
  ESP32-C6 + MMA845X (3-axis accelerometer only) -> USB Serial CSV

  Output ~50 Hz:
    pitch,roll,yaw
  yaw is always 0.0 (accelerometer cannot measure heading — column kept for the web app).

  Tilt math (stationary / slow motion):
    1) Low-pass filter raw ax,ay,az (g) to cut vibration noise.
    2) Normalize to unit vector ≈ gravity direction (reduces small scale error).
    3) roll  = atan2(ay, az)
       pitch = atan2(-ax, sqrt(ay² + az²))
    Frames with |a| far from 1 g are skipped (linear acceleration corrupts tilt).

  If pitch/roll feel swapped or inverted vs your mount, flip signs below (AX_SIGN …).

  ESP32-C6 I2C: SDA=GPIO6, SCL=GPIO7
  MMA845X @ 0x1C (SA0 to GND on many boards)

  Localhost:
    npm run serial:bridge -- --port <port>
    Browser: ws://127.0.0.1:8787
*/

#include <Wire.h>

static const int PIN_SDA = 6;
static const int PIN_SCL = 7;
static const uint8_t IMU_ADDR = 0x1C;

// Mount / axis fixes (±1.0f). Change if your board is rotated vs the model.
static const float AX_SIGN = +1.0f;
static const float AY_SIGN = +1.0f;
static const float AZ_SIGN = +1.0f;

static const uint8_t MMA_WHO_AM_I = 0x0D;
static const uint8_t MMA_CTRL_REG1 = 0x2A;
static const uint8_t MMA_XYZ_DATA_CFG = 0x0E;
static const uint8_t MMA_OUT_X_MSB = 0x01;
static const uint8_t MMA8451_ID = 0x1A;
static const uint8_t MMA8452_ID = 0x2A;

bool imuReady = false;

float pitchDeg = 0.0f;
float rollDeg = 0.0f;
float yawDeg = 0.0f;

unsigned long lastSendMs = 0;
unsigned long lastRetryMs = 0;

// IIR on accelerometer (g) before tilt — higher = snappier, lower = smoother
static const float ACC_LP = 0.38f;
static float fax = 0.0f;
static float fay = 0.0f;
static float faz = 0.0f;
static bool accFiltInit = false;

// Output smoothing (degrees on wire)
static const float OUT_LP = 0.20f;

bool i2cProbe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool i2cWrite8(uint8_t addr, uint8_t reg, uint8_t v) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

uint8_t i2cRead8(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0xFF;
  if (Wire.requestFrom((int)addr, 1) != 1) return 0xFF;
  return Wire.read();
}

bool i2cReadRegs(uint8_t addr, uint8_t reg, uint8_t *buf, size_t len) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, (int)len) != (int)len) return false;
  for (size_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

inline bool imuWriteReg(uint8_t reg, uint8_t v) { return i2cWrite8(IMU_ADDR, reg, v); }
inline uint8_t imuReadReg8(uint8_t reg) { return i2cRead8(IMU_ADDR, reg); }
inline bool imuReadRegs(uint8_t reg, uint8_t *buf, size_t len) {
  return i2cReadRegs(IMU_ADDR, reg, buf, len);
}

bool initMma845x() {
  if (!imuWriteReg(MMA_CTRL_REG1, 0x00)) return false; // standby
  delay(10);
  if (!imuWriteReg(MMA_XYZ_DATA_CFG, 0x00)) return false; // ±2g
  // 100 Hz DR, active (common stable setting)
  if (!imuWriteReg(MMA_CTRL_REG1, 0x19)) return false;
  delay(10);
  return true;
}

bool detectAndInitImu() {
  if (!i2cProbe(IMU_ADDR)) {
    Serial.println("[IMU] No ACK at 0x1C");
    imuReady = false;
    return false;
  }

  uint8_t who = imuReadReg8(MMA_WHO_AM_I);
  Serial.print("[IMU] WHO_AM_I @0x0D = 0x");
  if (who < 16) Serial.print('0');
  Serial.println(who, HEX);

  if (who == MMA8451_ID || who == MMA8452_ID) {
    if (!initMma845x()) {
      imuReady = false;
      return false;
    }
    Serial.println("[IMU] MMA845X OK (accel-only, yaw=0)");
    imuReady = true;
    accFiltInit = false;
    return true;
  }

  Serial.println("[IMU] Unknown WHO_AM_I — trying generic MMA845x init...");
  if (initMma845x()) {
    Serial.println("[IMU] Generic MMA845x init OK");
    imuReady = true;
    accFiltInit = false;
    return true;
  }
  imuReady = false;
  return false;
}

static int16_t mma14FromPair(uint8_t msb, uint8_t lsb) {
  return (int16_t)(((uint16_t)msb << 8) | (uint16_t)lsb) >> 2;
}

void updateFromAccelOnly() {
  uint8_t buf[6];
  if (!imuReadRegs(MMA_OUT_X_MSB, buf, 6)) return;

  int16_t iraw = mma14FromPair(buf[0], buf[1]);
  int16_t jraw = mma14FromPair(buf[2], buf[3]);
  int16_t kraw = mma14FromPair(buf[4], buf[5]);

  const float gPerLsb = 1.0f / 4096.0f; // ±2g, 14-bit
  float x = iraw * gPerLsb * AX_SIGN;
  float y = jraw * gPerLsb * AY_SIGN;
  float z = kraw * gPerLsb * AZ_SIGN;

  float rawMag = sqrtf(x * x + y * y + z * z);
  if (rawMag < 0.82f || rawMag > 1.18f) {
    // Not ~1g — likely shake/translation; keep last pitch/roll
    return;
  }

  if (!accFiltInit) {
    fax = x;
    fay = y;
    faz = z;
    accFiltInit = true;
  } else {
    fax += (x - fax) * ACC_LP;
    fay += (y - fay) * ACC_LP;
    faz += (z - faz) * ACC_LP;
  }

  float nx = fax;
  float ny = fay;
  float nz = faz;
  float m = sqrtf(nx * nx + ny * ny + nz * nz);
  if (m < 1e-4f) return;
  nx /= m;
  ny /= m;
  nz /= m;

  rollDeg = atan2f(ny, nz) * 180.0f / PI;
  pitchDeg = atan2f(-nx, sqrtf(ny * ny + nz * nz)) * 180.0f / PI;
  yawDeg = 0.0f;
}

void setup() {
  Serial.begin(115200);
  delay(400);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);

  Serial.println("ESP32 — MMA845X 3-axis accelerometer (pitch/roll only, yaw=0)");
  if (!detectAndInitImu()) {
    Serial.println("[IMU] Init failed.");
  }

  lastSendMs = millis();
}

void loop() {
  if (!imuReady) {
    if (millis() - lastRetryMs >= 2000) {
      lastRetryMs = millis();
      Serial.println("IMU_NOT_READY -> retry...");
      detectAndInitImu();
    }
    delay(500);
    return;
  }

  updateFromAccelOnly();

  if (millis() - lastSendMs >= 20) {
    lastSendMs = millis();
    static float fp = 0, fr = 0;
    static bool outOk = false;
    if (!outOk) {
      fp = pitchDeg;
      fr = rollDeg;
      outOk = true;
    } else {
      fp += (pitchDeg - fp) * OUT_LP;
      fr += (rollDeg - fr) * OUT_LP;
    }
    char payload[64];
    snprintf(payload, sizeof(payload), "%.2f,%.2f,0.00", fp, fr);
    Serial.println(payload);
  }
}

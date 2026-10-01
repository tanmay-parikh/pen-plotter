/*
 * PenPlotter — firmware for the PlotWrite web app
 * Board:  Arduino Uno
 * Motors: 2 × 28BYJ-48 (ULN2003 drivers) for X and Y, 1 × SG90 servo for the pen
 * Link:   BLE UART module (HM-10 / AT-09 / CC41 clone) on SoftwareSerial, 9600 baud.
 *         USB serial (115200) accepts the same commands for bench testing.
 *
 * Wiring (see README.md for the diagram)
 *   X stepper  ULN2003 IN1..IN4 -> D2, D3, D4, D5
 *   Y stepper  ULN2003 IN1..IN4 -> D6, D7, D8, D9
 *   Servo      signal           -> D10   (power it from the 5 V motor supply, NOT the Uno pin)
 *   BLE        module TXD       -> D11   (Arduino RX)
 *              module RXD       -> D12   (Arduino TX, through a 1k/2k divider: module is 3.3 V)
 *   Common GND between Uno, ULN2003 boards, servo and BLE module.
 *
 * Protocol: one ASCII command per line. Every command is answered with "ok" once it
 * has FINISHED (or "err <reason>"). The app keeps a few commands in flight, the
 * firmware buffers up to QUEUE_SIZE of them.
 *
 *   PING                 -> ok
 *   ?                    -> pos <x> <y> <pen>   then ok
 *   PEN_UP / PEN_DOWN    lift / lower the pen
 *   HOME                 pen up, move to (0,0)
 *   ZERO                 declare the current position as (0,0)
 *   G X<mm> Y<mm>        absolute move (either axis optional)
 *   JOG X<mm> Y<mm>      relative move with the pen lifted
 *   CFG <KEY> <value>    UP, DN (servo angles)  SPD, TSPD (mm/s)  SPMX, SPMY (steps/mm)  INVX, INVY (0/1)
 *   STOP                 immediate: abort motion, flush queue, lift pen, answers "stopped"
 *
 * No external libraries beyond the ones bundled with the Arduino IDE (Servo, SoftwareSerial).
 */

#include <Servo.h>
#include <SoftwareSerial.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>

// ------------------------------------------------------------------ pins --
const uint8_t X_PINS[4] = {2, 3, 4, 5};
const uint8_t Y_PINS[4] = {6, 7, 8, 9};
const uint8_t SERVO_PIN = 10;
const uint8_t BLE_RX_PIN = 11;
const uint8_t BLE_TX_PIN = 12;

// -------------------------------------------------------------- defaults --
// All of these can be changed at runtime from the web app (CFG command).
float stepsPerMmX = 102.4;      // 4096 half-steps/rev ÷ 40 mm per rev (GT2 belt, 20T pulley)
float stepsPerMmY = 102.4;
float drawSpeed   = 6.0;        // mm/s with the pen down
float travelSpeed = 8.0;        // mm/s with the pen up
int   penUpAngle   = 60;
int   penDownAngle = 30;
bool  invertX = false;
bool  invertY = false;

const unsigned long MIN_STEP_US   = 1200;   // fastest reliable half-step rate for a 28BYJ-48 at 5 V
const unsigned int  PEN_UP_MS     = 220;    // servo settle times
const unsigned int  PEN_DOWN_MS   = 280;
const unsigned long IDLE_RELEASE_MS = 2000; // de-energise coils + servo after this much idle time

// ------------------------------------------------------------------ state --
const uint8_t QUEUE_SIZE = 8;

enum CmdType : uint8_t { C_PING, C_POS, C_PEN_UP, C_PEN_DOWN, C_HOME, C_ZERO, C_MOVE, C_JOG, C_CFG };
enum CfgKey  : uint8_t { K_UP, K_DN, K_SPD, K_TSPD, K_SPMX, K_SPMY, K_INVX, K_INVY };

struct Cmd {
  CmdType type;
  float a;   // X / dx / cfg key
  float b;   // Y / dy / cfg value
};

Cmd queue[QUEUE_SIZE];
uint8_t qHead = 0, qTail = 0, qCount = 0;

SoftwareSerial ble(BLE_RX_PIN, BLE_TX_PIN);
Servo pen;
bool penAttached = false;
bool penIsDown = false;

long posX = 0, posY = 0;                  // current position in steps
int8_t phaseX = 0, phaseY = 0;            // current half-step phase of each motor
bool coilsOn = false;
unsigned long lastActivity = 0;

volatile bool stopRequested = false;

char bufUsb[40], bufBle[40];
uint8_t lenUsb = 0, lenBle = 0;

// 28BYJ-48 half-step sequence, bit3 -> IN1 ... bit0 -> IN4
const uint8_t HALF_STEP[8] = {0b1000, 0b1100, 0b0100, 0b0110, 0b0010, 0b0011, 0b0001, 0b1001};

// ---------------------------------------------------------------- output --
void say(const __FlashStringHelper* s) { Serial.println(s); ble.println(s); }
void say(const char* s)                { Serial.println(s); ble.println(s); }

void sayPos() {
  char line[40], xs[12], ys[12];
  dtostrf(posX / stepsPerMmX, 1, 2, xs);
  dtostrf(posY / stepsPerMmY, 1, 2, ys);
  snprintf(line, sizeof(line), "pos %s %s %d", xs, ys, penIsDown ? 1 : 0);
  say(line);
}

// ---------------------------------------------------------------- queue --
bool enqueue(const Cmd& c) {
  if (qCount >= QUEUE_SIZE) return false;
  queue[qTail] = c;
  qTail = (qTail + 1) % QUEUE_SIZE;
  qCount++;
  return true;
}

bool dequeue(Cmd& c) {
  if (!qCount) return false;
  c = queue[qHead];
  qHead = (qHead + 1) % QUEUE_SIZE;
  qCount--;
  return true;
}

void flushQueue() { qHead = qTail = qCount = 0; }

// ---------------------------------------------------------------- parsing --
// Reads "X12.5" / "Y-3" style fields. Returns NAN if the axis letter is absent.
float field(const char* s, char axis) {
  const char* p = strchr(s, axis);
  return p ? (float)atof(p + 1) : NAN;
}

// Returns true if the line produced a queued command (or was handled immediately).
void handleLine(char* s) {
  while (*s == ' ') s++;
  if (!*s) return;
  for (char* p = s; *p; p++) if (*p >= 'a' && *p <= 'z') *p -= 32;

  if (!strcmp(s, "STOP")) { stopRequested = true; return; }

  Cmd c = {C_PING, 0, 0};
  if      (!strcmp(s, "PING"))     c.type = C_PING;
  else if (!strcmp(s, "?"))        c.type = C_POS;
  else if (!strcmp(s, "PEN_UP"))   c.type = C_PEN_UP;
  else if (!strcmp(s, "PEN_DOWN")) c.type = C_PEN_DOWN;
  else if (!strcmp(s, "HOME"))     c.type = C_HOME;
  else if (!strcmp(s, "ZERO"))     c.type = C_ZERO;
  else if (!strncmp(s, "G ", 2) || !strncmp(s, "JOG ", 4)) {
    c.type = (s[0] == 'J') ? C_JOG : C_MOVE;
    c.a = field(s, 'X');
    c.b = field(s, 'Y');
  }
  else if (!strncmp(s, "CFG ", 4)) {
    char* key = s + 4;
    char* val = strchr(key, ' ');
    if (!val) { say(F("err cfg")); return; }
    *val++ = 0;
    c.type = C_CFG;
    c.b = (float)atof(val);
    if      (!strcmp(key, "UP"))   c.a = K_UP;
    else if (!strcmp(key, "DN"))   c.a = K_DN;
    else if (!strcmp(key, "SPD"))  c.a = K_SPD;
    else if (!strcmp(key, "TSPD")) c.a = K_TSPD;
    else if (!strcmp(key, "SPMX")) c.a = K_SPMX;
    else if (!strcmp(key, "SPMY")) c.a = K_SPMY;
    else if (!strcmp(key, "INVX")) c.a = K_INVX;
    else if (!strcmp(key, "INVY")) c.a = K_INVY;
    else { say(F("err key")); return; }
  }
  else { say(F("err unknown")); return; }

  if (!enqueue(c)) say(F("err full"));
}

void feed(Stream& port, char* buf, uint8_t& len) {
  while (port.available()) {
    char ch = (char)port.read();
    if (ch == '\n' || ch == '\r') {
      if (len) { buf[len] = 0; handleLine(buf); len = 0; }
    } else if (len < sizeof(bufUsb) - 1) {
      buf[len++] = ch;
    } else {
      len = 0;                       // overlong line: drop it
      say(F("err long"));
    }
  }
}

// Called from inside long operations so STOP and new commands are never missed.
void pollSerial() {
  feed(Serial, bufUsb, lenUsb);
  feed(ble, bufBle, lenBle);
}

// ------------------------------------------------------------------ motors --
void writeCoils(const uint8_t pins[4], int8_t phase) {
  uint8_t bits = HALF_STEP[phase & 7];
  for (uint8_t i = 0; i < 4; i++) digitalWrite(pins[i], (bits >> (3 - i)) & 1);
}

void releaseCoils() {
  for (uint8_t i = 0; i < 4; i++) { digitalWrite(X_PINS[i], LOW); digitalWrite(Y_PINS[i], LOW); }
  coilsOn = false;
}

inline void stepX(int8_t dir) { phaseX = (phaseX + (invertX ? -dir : dir)) & 7; writeCoils(X_PINS, phaseX); posX += dir; }
inline void stepY(int8_t dir) { phaseY = (phaseY + (invertY ? -dir : dir)) & 7; writeCoils(Y_PINS, phaseY); posY += dir; }

// Wait until `deadline` (micros) while still servicing the serial ports.
void waitUntil(unsigned long deadline) {
  while ((long)(micros() - deadline) < 0) {
    if (stopRequested) return;
    pollSerial();
  }
}

// Straight-line move (Bresenham over half-steps) at the speed for the current pen state.
void moveToMm(float xmm, float ymm) {
  long tx = lroundf(xmm * stepsPerMmX);
  long ty = lroundf(ymm * stepsPerMmY);
  long dx = tx - posX, dy = ty - posY;
  long ax = labs(dx), ay = labs(dy);
  long major = ax > ay ? ax : ay;
  if (!major) return;

  float distMm = sqrtf((dx / stepsPerMmX) * (dx / stepsPerMmX) + (dy / stepsPerMmY) * (dy / stepsPerMmY));
  float speed = penIsDown ? drawSpeed : travelSpeed;
  if (speed < 0.5f) speed = 0.5f;
  unsigned long stepUs = (unsigned long)((distMm / speed) * 1000000.0f / (float)major);
  if (stepUs < MIN_STEP_US) stepUs = MIN_STEP_US;

  int8_t sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
  long accX = 0, accY = 0;
  coilsOn = true;
  unsigned long next = micros();

  for (long i = 0; i < major; i++) {
    accX += ax; accY += ay;
    if (accX >= major) { accX -= major; stepX(sx); }
    if (accY >= major) { accY -= major; stepY(sy); }
    next += stepUs;
    waitUntil(next);
    if (stopRequested) return;
  }
}

// -------------------------------------------------------------------- pen --
void setPen(bool down) {
  if (!penAttached) { pen.attach(SERVO_PIN); penAttached = true; }
  pen.write(down ? penDownAngle : penUpAngle);
  penIsDown = down;
  unsigned long until = millis() + (down ? PEN_DOWN_MS : PEN_UP_MS);
  while ((long)(millis() - until) < 0) { if (stopRequested) return; pollSerial(); }
}

// ---------------------------------------------------------------- execute --
void execute(const Cmd& c) {
  switch (c.type) {
    case C_PING:     break;
    case C_POS:      sayPos(); break;
    case C_PEN_UP:   setPen(false); break;
    case C_PEN_DOWN: setPen(true);  break;
    case C_ZERO:     posX = 0; posY = 0; break;
    case C_HOME:
      if (penIsDown) setPen(false);
      moveToMm(0, 0);
      break;
    case C_MOVE: {
      float x = isnan(c.a) ? posX / stepsPerMmX : c.a;
      float y = isnan(c.b) ? posY / stepsPerMmY : c.b;
      moveToMm(x, y);
      break;
    }
    case C_JOG: {
      if (penIsDown) setPen(false);
      float x = posX / stepsPerMmX + (isnan(c.a) ? 0 : c.a);
      float y = posY / stepsPerMmY + (isnan(c.b) ? 0 : c.b);
      moveToMm(x, y);
      break;
    }
    case C_CFG: {
      float v = c.b;
      switch ((CfgKey)(int)c.a) {
        case K_UP:   penUpAngle   = constrain((int)v, 0, 180); if (penAttached && !penIsDown) pen.write(penUpAngle);   break;
        case K_DN:   penDownAngle = constrain((int)v, 0, 180); if (penAttached && penIsDown)  pen.write(penDownAngle); break;
        case K_SPD:  if (v > 0) drawSpeed   = v; break;
        case K_TSPD: if (v > 0) travelSpeed = v; break;
        case K_SPMX: if (v > 0) { posX = lroundf(posX / stepsPerMmX * v); stepsPerMmX = v; } break;
        case K_SPMY: if (v > 0) { posY = lroundf(posY / stepsPerMmY * v); stepsPerMmY = v; } break;
        case K_INVX: invertX = v > 0.5f; break;
        case K_INVY: invertY = v > 0.5f; break;
      }
      break;
    }
  }
}

void handleStop() {
  stopRequested = false;
  flushQueue();
  setPen(false);
  lastActivity = millis();
  say(F("stopped"));
}

// ------------------------------------------------------------------- setup --
void setup() {
  for (uint8_t i = 0; i < 4; i++) {
    pinMode(X_PINS[i], OUTPUT); digitalWrite(X_PINS[i], LOW);
    pinMode(Y_PINS[i], OUTPUT); digitalWrite(Y_PINS[i], LOW);
  }
  Serial.begin(115200);
  ble.begin(9600);          // HM-10 default; change both here and on the module if you re-configure it
  ble.listen();
  setPen(false);            // start with the pen lifted
  lastActivity = millis();
  say(F("ready"));
}

// -------------------------------------------------------------------- loop --
void loop() {
  pollSerial();

  if (stopRequested) { handleStop(); return; }

  Cmd c;
  if (dequeue(c)) {
    execute(c);
    lastActivity = millis();
    if (stopRequested) { handleStop(); return; }   // aborted mid-command: no "ok", just "stopped"
    say(F("ok"));
    return;
  }

  // Idle: let the motors cool down and stop the servo from buzzing.
  if ((coilsOn || penAttached) && millis() - lastActivity > IDLE_RELEASE_MS) {
    if (coilsOn) releaseCoils();
    if (penAttached) { pen.detach(); penAttached = false; }
  }
}

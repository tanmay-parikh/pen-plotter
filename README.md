# PlotWrite — A4 pen plotter studio

A lightweight, dependency-free web app (plain HTML/CSS/JS, no build step) that turns typed text into
single-line pen strokes and streams them over **Web Bluetooth** to an **Arduino Uno** driving two
**28BYJ-48** steppers and an **SG90** pen-lift servo.

* Automatic word wrap inside the A4 margins (210 × 297 mm)
* Built-in monoline vector font (swappable for Hershey data, see `js/font.js`)
* Font size, letter spacing, line spacing, margin and alignment controls
* Interactive canvas preview (zoom, pan, live pen position, plotted-so-far overlay)
* Manual Home / Pen up / Pen down / Jog / Set-origin controls
* Automatic `PEN_UP` between letters and lines, `PEN_DOWN` only while drawing
* Ack-based streaming with pause / resume / emergency stop
* **Simulator mode**: test the entire pipeline with no hardware
* 50 mm calibration square, SVG export, light/dark theme, settings remembered

```
index.html          the app
css/styles.css
js/font.js          single-line font + glyph compiler
js/layout.js        text -> wrapped lines -> strokes (mm)
js/job.js           strokes -> PEN_UP / PEN_DOWN / G commands, time estimate, SVG export
js/transport.js     Web Bluetooth transport + software simulator of the firmware
js/plotter.js       command/ack bookkeeping, job streaming, pause, stop
js/preview.js       interactive canvas
js/app.js           UI wiring
firmware/PenPlotter/PenPlotter.ino    Arduino Uno firmware
```

---

## 1. Run it locally

Web Bluetooth only works on `https://` or `http://localhost`, so use a tiny local server.

```powershell
cd D:\kids_projects\pen-plotter
python -m http.server 8000
```

…or double-click **`serve.bat`**. Open <http://localhost:8000> in **Chrome or Edge**
(Firefox and Safari do not implement Web Bluetooth; the layout and Simulator still work there).

Try it without hardware first: click **Simulator**, jog the pen, press **Start plotting**.
Set *Machine settings → Simulator speed* to 20× to watch a page "plot" in a minute.

## 2. Hardware

| Part | Connection |
|---|---|
| X stepper (ULN2003) | IN1–IN4 → D2, D3, D4, D5 |
| Y stepper (ULN2003) | IN1–IN4 → D6, D7, D8, D9 |
| SG90 servo | signal → D10, **power from the 5 V motor supply** |
| BLE module TXD | → D11 (Arduino RX) |
| BLE module RXD | ← D12 (Arduino TX) **through a 1 kΩ / 2 kΩ divider** (module is 3.3 V) |
| Grounds | Uno, both ULN2003 boards, servo and BLE module share GND |

* Power the motors and servo from a separate 5 V ≥ 2 A supply, not the Uno's 5 V pin.
* The module **must be BLE** (HM-10, AT-09, CC41, …). Classic-Bluetooth modules such as the
  HC-05/HC-06/JDY-31 are invisible to Web Bluetooth.
* HM-10 default is 9600 baud, which matches the firmware. Its UUIDs (service `FFE0`,
  characteristic `FFE1`) are the app's default profile; Nordic-UART and custom UUIDs are in
  *Machine settings*.

Flash `firmware/PenPlotter/PenPlotter.ino` with the Arduino IDE (board: Arduino Uno). It only uses
the bundled `Servo` and `SoftwareSerial` libraries. You can also test over USB at 115200 baud
by typing commands (`PING`, `?`, `G X20 Y20`) into the Serial Monitor.

## 3. First plot checklist

1. Tape an A4 sheet flat. Connect (Bluetooth button) – the app pings the Arduino and uploads its settings.
2. **Pen angles**: Machine settings → *Test up / Test down* until the pen clears the paper when up and
   touches lightly when down.
3. **Jog** the pen to the top-left corner of the sheet and press **Set origin**
   (the page origin is the top-left corner, +X right, +Y down the sheet).
4. If an axis moves the wrong way, tick *Invert X/Y motor direction*.
5. **Calibrate**: *Draw 50 mm test square*, measure it, then
   `new steps/mm = old steps/mm × 50 ÷ measured mm` (per axis).
   The default 102.4 steps/mm assumes a 20-tooth GT2 pulley on a half-stepped 28BYJ-48.
6. Press **Start plotting**. **Stop** lifts the pen and flushes the Arduino queue immediately.

Notes: keep the browser tab visible while plotting (the app requests a screen wake-lock; background tabs
are throttled). A 28BYJ-48 is slow – the default 6 mm/s draw speed is realistic, and a full page of text takes a while.

## 4. Protocol (for hacking)

One ASCII command per line; the firmware replies `ok` when the command has **finished**
(or `err <reason>`), and the app keeps up to 3 commands in flight.

```
PING | ? | HOME | ZERO | PEN_UP | PEN_DOWN | STOP
G X<mm> Y<mm>          absolute move
JOG X<mm> Y<mm>        relative move, pen lifted
CFG UP|DN|SPD|TSPD|SPMX|SPMY|INVX|INVY <value>
```

## 5. Publish to GitHub Pages

The site is fully static and already contains a `.nojekyll` file, so no build step is needed.
GitHub Pages serves over HTTPS, which Web Bluetooth requires.

**Option A – GitHub CLI** (installed on this machine)

```powershell
cd D:\kids_projects\pen-plotter
git init -b main
git add .
git commit -m "PlotWrite: A4 pen plotter studio"
gh auth login                      # first time only
gh repo create plotwrite --public --source . --remote origin --push
gh api -X POST repos/:owner/plotwrite/pages -f "source[branch]=main" -f "source[path]=/"
```

**Option B – website**

1. Create an empty repository on github.com (e.g. `plotwrite`).
2. `git init -b main; git add .; git commit -m "PlotWrite"`
3. `git remote add origin https://github.com/<you>/plotwrite.git; git push -u origin main`
4. Repo → **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save.**

After about a minute the app is live at `https://<you>.github.io/plotwrite/`.
Open that URL in Chrome/Edge on a laptop or an Android phone and connect to the plotter.
To update later: commit and `git push`.

> GitHub Pages on a free account requires a **public** repository.

## License

Use freely for your own plotter.

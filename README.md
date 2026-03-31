# 3D Render and attitude Viwer using ESP32

This project uses small Vite + Three.js viewer that tilts a GLB model from live sensor data. Firmware is ESP32-C6, and MMA845X **3-axis accelerometer** (pitch/roll only; yaw stays 0).

## Run the app

```bash
npm install
npm run dev
```

Drop models in `public/` as `rambling_wreck.glb` and/or `airplane.glb` (pick in the UI).

## Feed data in (pick one)

**USB + serial bridge **  
Flash `arduino_code/esp32_imu_serial/esp32_imu_serial.ino`, then:

```bash
npm run serial:bridge -- --port /dev/cu.YOUR_PORT
```

In the UI: `127.0.0.1`, port `8787`, Connect.

**Wi‑Fi ESP32 WebSocket**  
If your board serves `pitch,roll,yaw` CSV on port 81, put its LAN IP in the UI and connect.

**No hardware**  
`npm run ws:test` (port `8765`) or enable “Test motion” in the panel.

**Hardware setup**
The image for hardware setup is in `hardware/setup.JPG`. Vcc_in connects to 3.3V, GNG to ESP32's ground. GPIO 6 is SDA and GPIO 7 is SCL. Connect ESP32 to computer and upload code. 

## Notes

- I2C on C6 here is SDA `6`, SCL `7`; sensor showed up at `0x1C` on our setup.
- Use mount trim in the UI if the board sits crooked at rest.

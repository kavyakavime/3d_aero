# 3D Render and attitude Viwer using ESP32

This project uses small Vite + Three.js viewer that tilts a GLB model from live sensor data. Firmware is ESP32-C6, and MMA845X **3-axis accelerometer** (pitch/roll only).

## Run the app

```bash
npm install
npm run dev
```
Pick from `public/` as `rambling_wreck.glb` and/or `airplane.glb`. The 3D model for `rambling_wreck.glb` was created by me, while the `airplane.glb` is from Sketchfab. 

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

**Results**
The results directory only shows the pictures of the renderings. Link for video:
Rambling Wreck:  
```
https://drive.google.com/file/d/12UOh0tWQNU0-OsXlbATZGLG1WdNpKXCz/view?usp=sharing
```
Plane:
```
https://drive.google.com/file/d/1n62SrJby33t3vYYgOhSjP7cuDgLqzHXp/view?usp=sharing
```

## Notes

- I2C on C6 here is SDA `6`, SCL `7`.


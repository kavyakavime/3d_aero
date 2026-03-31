/**
 * In the app: IP 127.0.0.1 — Port 8765 — Connect to ESP32
 */
import { WebSocketServer } from 'ws';

const PORT = 8765;
const wss = new WebSocketServer({ port: PORT });

let t = 0;
const intervalMs = 20;

wss.on('connection', (ws) => {
  const timer = setInterval(() => {
    t += intervalMs / 1000;
    const pitch = Math.sin(t * 1.2) * 22;
    const roll = Math.cos(t * 1.5) * 18;
    // Yaw fixed at 0 to match 3-axis accelerometer firmware (change if testing yaw)
    const yaw = 0;
    if (ws.readyState === ws.OPEN) {
      ws.send(`${pitch.toFixed(3)},${roll.toFixed(3)},${yaw.toFixed(3)}`);
    }
  }, intervalMs);

  ws.on('close', () => clearInterval(timer));
});

console.log(`[dev] Fake ESP32 WebSocket → ws://127.0.0.1:${PORT}`);
console.log('[dev] CSV: pitch,roll,yaw (degrees)');

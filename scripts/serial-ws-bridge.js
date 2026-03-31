/**
 * USB Serial -> WebSocket bridge for ESP32 (CSV pitch,roll,yaw — yaw often 0 for accel-only)
 *
 * Usage:
 *   npm run serial:bridge -- --port /dev/cu.usbserial-0001
 *   npm run serial:bridge -- --port COM5
 */
import { WebSocketServer } from 'ws';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const serialPath = getArg('port', '');
const baudRate = Number(getArg('baud', '115200'));
const wsPort = Number(getArg('ws-port', '8787'));

if (!serialPath) {
  console.error('Missing --port');
  console.error('Example: npm run serial:bridge -- --port /dev/cu.usbserial-0001');
  process.exit(1);
}

const ws = new WebSocketServer({ port: wsPort });
console.log(`[bridge] WebSocket listening: ws://127.0.0.1:${wsPort}`);

const port = new SerialPort({ path: serialPath, baudRate });
const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

port.on('open', () => {
  console.log(`[bridge] Serial open: ${serialPath} @ ${baudRate}`);
});

port.on('error', (err) => {
  console.error('[bridge] Serial error:', err.message);
});

parser.on('data', (line) => {
  const msg = String(line).trim();
  if (!msg) return;
  //only csv lines
  if (!/^[-+0-9.eE]+\s*,\s*[-+0-9.eE]+\s*,\s*[-+0-9.eE]+$/.test(msg)) return;
  ws.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  });
});

process.on('SIGINT', () => {
  console.log('\n[bridge] shutting down');
  try {
    port.close();
  } catch {
    // ignore
  }
  ws.close(() => process.exit(0));
});

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEG = Math.PI / 180;
const LS_IP = '3d-aero-esp32-ip';
const LS_PORT = '3d-aero-esp32-port';
const LS_MODEL = '3d-aero-model';
const LS_TRIM_PITCH = '3d-aero-trim-pitch';
const LS_TRIM_ROLL = '3d-aero-trim-roll';
const LS_TRIM_YAW = '3d-aero-trim-yaw';

const canvas = document.getElementById('bg');
const hudPitch = document.getElementById('hud-pitch');
const hudRoll = document.getElementById('hud-roll');
const hudYaw = document.getElementById('hud-yaw');
const hudSource = document.getElementById('hud-source');
const elEsp32Ip = document.getElementById('esp32-ip');
const elEsp32Port = document.getElementById('esp32-port');
const elWsPreviewUrl = document.getElementById('ws-preview-url');
const elModelSelect = document.getElementById('model-select');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const chkTest = document.getElementById('chk-test');
const chkDegrees = document.getElementById('chk-degrees');
const chkFollow = document.getElementById('chk-follow');
const elSensitivity = document.getElementById('sensitivity');
const sensLabel = document.getElementById('sens-label');
const elSmoothing = document.getElementById('smoothing');
const elTrimPitch = document.getElementById('trim-pitch');
const elTrimRoll = document.getElementById('trim-roll');
const elTrimYaw = document.getElementById('trim-yaw');
const btnReset = document.getElementById('btn-reset');

let sensitivity = Number(elSensitivity.value);
let smoothing = Number(elSmoothing.value);
sensLabel.textContent = `${sensitivity.toFixed(1)}×`;
let modelHudLabel = 'idle';
const MODEL_FILES = {
  rambling_wreck: '/rambling_wreck.glb',
  airplane: '/airplane.glb',
};
let currentModelKey = 'rambling_wreck';

try {
  const savedIp = localStorage.getItem(LS_IP);
  const savedPort = localStorage.getItem(LS_PORT);
  const savedModel = localStorage.getItem(LS_MODEL);
  if (savedIp) elEsp32Ip.value = savedIp;
  if (savedPort) elEsp32Port.value = savedPort;
  if (savedModel && MODEL_FILES[savedModel]) currentModelKey = savedModel;
  const tp = localStorage.getItem(LS_TRIM_PITCH);
  const tr = localStorage.getItem(LS_TRIM_ROLL);
  const ty = localStorage.getItem(LS_TRIM_YAW);
  if (tp !== null && tp !== '') elTrimPitch.value = tp;
  if (tr !== null && tr !== '') elTrimRoll.value = tr;
  if (ty !== null && ty !== '') elTrimYaw.value = ty;
} catch {
  /* ignore */
}
elModelSelect.value = currentModelKey;

function persistTrim() {
  try {
    localStorage.setItem(LS_TRIM_PITCH, elTrimPitch.value);
    localStorage.setItem(LS_TRIM_ROLL, elTrimRoll.value);
    localStorage.setItem(LS_TRIM_YAW, elTrimYaw.value);
  } catch {
    /* ignore */
  }
}

/** Subtract mount offsets (degrees in UI; converted if stream is radians). */
function applyMountTrim(pitch, roll, yaw) {
  const tp = Number(elTrimPitch.value);
  const tr = Number(elTrimRoll.value);
  const ty = Number(elTrimYaw.value);
  const offP = Number.isFinite(tp) ? tp : 0;
  const offR = Number.isFinite(tr) ? tr : 0;
  const offY = Number.isFinite(ty) ? ty : 0;
  if (chkDegrees.checked) {
    return { pitch: pitch - offP, roll: roll - offR, yaw: yaw - offY };
  }
  return {
    pitch: pitch - offP * DEG,
    roll: roll - offR * DEG,
    yaw: yaw - offY * DEG,
  };
}

const targetRot = new THREE.Euler(0, 0, 0, 'YXZ');
const smoothRot = new THREE.Euler(0, 0, 0, 'YXZ');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8f949c);
scene.fog = new THREE.Fog(0x8f949c, 11, 34);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
camera.position.set(4, 2.2, 6);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const hemi = new THREE.HemisphereLight(0xd5dae1, 0x6c7078, 0.95);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 1.25);
dir.position.set(5, 12, 8);
scene.add(dir);
const fill = new THREE.DirectionalLight(0xcfd4dc, 0.42);
fill.position.set(-6, 5, -4);
scene.add(fill);

const grid = new THREE.GridHelper(40, 40, 0x676c74, 0x7d838d);
grid.position.y = -0.01;
scene.add(grid);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = true;
controls.panSpeed = 0.85;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};
controls.target.set(0, 0.4, 0);

let viewPointerActive = false;
renderer.domElement.addEventListener('pointerdown', () => {
  viewPointerActive = true;
});
renderer.domElement.addEventListener('pointerup', () => {
  viewPointerActive = false;
});
renderer.domElement.addEventListener('pointercancel', () => {
  viewPointerActive = false;
});

let aircraft = null;
let socket = null;

/** Build ws:// URL to the ESP32 WebSocket server (IP from WiFi.localIP(), not MAC). */
function getEsp32WebSocketUrl() {
  const raw = elEsp32Ip.value.trim();
  if (!raw) return null;

  if (/^wss?:\/\//i.test(raw)) {
    return raw;
  }

  const port = Math.min(65535, Math.max(1, Number(elEsp32Port.value) || 81));
  let host = raw.replace(/^https?:\/\//i, '').trim();
  host = host.split('/')[0];
  if (host.includes(':') && !host.startsWith('[')) {
    const parts = host.split(':');
    const maybePort = parts[parts.length - 1];
    if (/^\d+$/.test(maybePort) && parts.length === 2) {
      host = parts[0];
      elEsp32Port.value = maybePort;
    }
  }
  return `ws://${host}:${port}`;
}

function updateWsPreview() {
  const url = getEsp32WebSocketUrl();
  elWsPreviewUrl.textContent = url || 'ws://…';
}

elEsp32Ip.addEventListener('input', updateWsPreview);
elEsp32Port.addEventListener('input', updateWsPreview);
updateWsPreview();

function persistEsp32Endpoint() {
  try {
    localStorage.setItem(LS_IP, elEsp32Ip.value.trim());
    localStorage.setItem(LS_PORT, String(elEsp32Port.value));
  } catch {
    /* ignore */
  }
}

function createPlaceholderAircraft() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22, 1.4, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x6b7a8f, metalness: 0.35, roughness: 0.45 }),
  );
  body.rotation.z = Math.PI / 2;
  g.add(body);

  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.06, 0.55),
    new THREE.MeshStandardMaterial({ color: 0x4a90d9, metalness: 0.2, roughness: 0.5 }),
  );
  wing.position.set(0.1, 0, 0);
  g.add(wing);

  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.55, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x5a6a80, metalness: 0.25, roughness: 0.5 }),
  );
  tail.position.set(-0.75, 0.15, 0);
  g.add(tail);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.35, 12),
    new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.4, roughness: 0.35 }),
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(0.95, 0, 0);
  g.add(nose);

  g.position.y = 0.5;
  return g;
}

function loadModel(modelKey) {
  const modelPath = MODEL_FILES[modelKey] || MODEL_FILES.rambling_wreck;
  const loader = new GLTFLoader();
  loader.load(
    modelPath,
    (gltf) => {
      const root = gltf.scene;
      root.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      box.getSize(size);
      const max = Math.max(size.x, size.y, size.z, 1e-6);
      const scale = 2.5 / max;
      root.scale.setScalar(scale);
      box.setFromObject(root);
      const center = new THREE.Vector3();
      box.getCenter(center);
      root.position.sub(center);
      root.position.y += 0.5;
      if (aircraft) {
        scene.remove(aircraft);
      }
      aircraft = root;
      scene.add(aircraft);
      modelHudLabel = `model: ${modelPath.slice(1)}`;
      if (!chkTest.checked && (!socket || socket.readyState !== WebSocket.OPEN)) {
        hudSource.textContent = modelHudLabel;
      }
    },
    undefined,
    () => {
      if (!aircraft) {
        aircraft = createPlaceholderAircraft();
        scene.add(aircraft);
        modelHudLabel = 'model: placeholder';
        if (!chkTest.checked && (!socket || socket.readyState !== WebSocket.OPEN)) {
          hudSource.textContent = modelHudLabel;
        }
      }
    },
  );
}

function loadSelectedModel() {
  if (aircraft) {
    scene.remove(aircraft);
    aircraft = null;
  }
  loadModel(currentModelKey);
}

function toRad(pitchDeg, rollDeg, yawDeg) {
  if (chkDegrees.checked) {
    return { x: pitchDeg * DEG, y: yawDeg * DEG, z: rollDeg * DEG };
  }
  return { x: pitchDeg, y: yawDeg, z: rollDeg };
}

function applyImu(pitch, roll, yaw, sourceTag) {
  const r = toRad(pitch, roll, yaw);
  targetRot.x = r.x * sensitivity;
  targetRot.y = r.y * sensitivity;
  targetRot.z = r.z * sensitivity;
  if (sourceTag) hudSource.textContent = sourceTag;
}

/** Extra low-pass on serial/WebSocket angles (reduces IMU jitter before targetRot). */
const STREAM_LP = 0.28;
let streamImuInit = false;
let streamP = 0;
let streamR = 0;
let streamY = 0;

function smoothStreamAngles(pitch, roll, yaw) {
  if (!streamImuInit) {
    streamP = pitch;
    streamR = roll;
    streamY = yaw;
    streamImuInit = true;
  } else {
    streamP += (pitch - streamP) * STREAM_LP;
    streamR += (roll - streamR) * STREAM_LP;
    streamY += (yaw - streamY) * STREAM_LP;
  }
  return { pitch: streamP, roll: streamR, yaw: streamY };
}

function resetStreamSmoother() {
  streamImuInit = false;
}

function resetOrientation() {
  resetStreamSmoother();
  targetRot.set(0, 0, 0, 'YXZ');
  smoothRot.set(0, 0, 0, 'YXZ');
  if (aircraft) {
    aircraft.rotation.set(0, 0, 0);
    aircraft.rotation.order = 'YXZ';
  }
  updateHud(0, 0, 0);
}

function updateHud(pitchDeg, rollDeg, yawDeg) {
  const fmt = (v) => `${v.toFixed(1)}°`;
  hudPitch.textContent = fmt(pitchDeg);
  hudRoll.textContent = fmt(rollDeg);
  hudYaw.textContent = fmt(yawDeg);
}

function eulerToDisplayDeg() {
  if (!aircraft) return { pitch: 0, roll: 0, yaw: 0 };
  const e = aircraft.rotation;
  if (chkDegrees.checked) {
    return { pitch: e.x / DEG, roll: e.z / DEG, yaw: e.y / DEG };
  }
  return { pitch: e.x, roll: e.z, yaw: e.y };
}

function connectToEsp32() {
  const url = getEsp32WebSocketUrl();
  if (!url) {
    hudSource.textContent = 'enter ESP32 IP';
    return;
  }
  disconnectWs();
  chkTest.checked = false;
  try {
    socket = new WebSocket(url);
  } catch {
    hudSource.textContent = 'invalid WebSocket URL';
    return;
  }
  btnConnect.disabled = true;
  hudSource.textContent = 'ESP32: connecting…';

  socket.addEventListener('open', () => {
    hudSource.textContent = 'ESP32: live';
    btnDisconnect.disabled = false;
    persistEsp32Endpoint();
  });

  socket.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : '';
    const parts = raw.trim().split(/[,\s]+/).filter(Boolean);
    if (parts.length < 3) return;
    const pitch = Number(parts[0]);
    const roll = Number(parts[1]);
    const yaw = Number(parts[2]);
    if (!Number.isFinite(pitch) || !Number.isFinite(roll) || !Number.isFinite(yaw)) return;
    const trimmed = applyMountTrim(pitch, roll, yaw);
    const s = smoothStreamAngles(trimmed.pitch, trimmed.roll, trimmed.yaw);
    applyImu(s.pitch, s.roll, s.yaw, 'ESP32: live');
    const d = chkDegrees.checked
      ? { pitch: s.pitch, roll: s.roll, yaw: s.yaw }
      : {
          pitch: s.pitch * (180 / Math.PI),
          roll: s.roll * (180 / Math.PI),
          yaw: s.yaw * (180 / Math.PI),
        };
    updateHud(d.pitch, d.roll, d.yaw);
  });

  socket.addEventListener('close', () => {
    btnConnect.disabled = false;
    btnDisconnect.disabled = true;
    socket = null;
    if (!chkTest.checked) hudSource.textContent = modelHudLabel;
  });

  socket.addEventListener('error', () => {
    hudSource.textContent = 'ESP32: connection error';
  });
}

function disconnectWs() {
  if (socket) {
    socket.close();
    socket = null;
  }
  resetStreamSmoother();
  btnConnect.disabled = false;
  btnDisconnect.disabled = true;
}

let testT = 0;
const clock = new THREE.Clock();

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

window.addEventListener('resize', resize);
resize();

loadSelectedModel();

elSensitivity.addEventListener('input', () => {
  sensitivity = Number(elSensitivity.value);
  sensLabel.textContent = `${sensitivity.toFixed(1)}×`;
});

elSmoothing.addEventListener('input', () => {
  smoothing = Number(elSmoothing.value);
});

function onTrimChange() {
  persistTrim();
  resetStreamSmoother();
}
elTrimPitch.addEventListener('change', onTrimChange);
elTrimRoll.addEventListener('change', onTrimChange);
elTrimYaw.addEventListener('change', onTrimChange);
elTrimPitch.addEventListener('input', onTrimChange);
elTrimRoll.addEventListener('input', onTrimChange);
elTrimYaw.addEventListener('input', onTrimChange);

chkDegrees.addEventListener('change', () => {
  resetStreamSmoother();
});

btnConnect.addEventListener('click', connectToEsp32);
btnDisconnect.addEventListener('click', () => {
  disconnectWs();
  if (!chkTest.checked) hudSource.textContent = modelHudLabel;
});

btnReset.addEventListener('click', resetOrientation);
elModelSelect.addEventListener('change', () => {
  currentModelKey = elModelSelect.value in MODEL_FILES ? elModelSelect.value : 'rambling_wreck';
  try {
    localStorage.setItem(LS_MODEL, currentModelKey);
  } catch {
    /* ignore */
  }
  resetOrientation();
  loadSelectedModel();
});

chkTest.addEventListener('change', () => {
  if (chkTest.checked) {
    disconnectWs();
    hudSource.textContent = 'test motion';
  } else {
    hudSource.textContent = socket?.readyState === WebSocket.OPEN ? 'ESP32: live' : modelHudLabel;
  }
});

function followCamera(dt) {
  if (!aircraft || !chkFollow.checked || viewPointerActive) return;
  const offset = new THREE.Vector3(-5, 1.8, 0);
  offset.applyQuaternion(aircraft.quaternion);
  const desired = aircraft.position.clone().add(offset);
  camera.position.lerp(desired, 1 - Math.pow(0.001, dt));
  controls.target.lerp(aircraft.position.clone().add(new THREE.Vector3(0, 0.2, 0)), 1 - Math.pow(0.001, dt));
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.08, clock.getDelta() || 0.016);

  if (chkTest.checked && aircraft) {
    testT += dt;
    const wobble = 25;
    applyImu(
      Math.sin(testT * 0.9) * wobble,
      Math.cos(testT * 1.1) * wobble * 0.7,
      Math.sin(testT * 0.35) * 40,
      'test motion',
    );
  }

  if (aircraft) {
    const a = 1 - smoothing;
    smoothRot.x += (targetRot.x - smoothRot.x) * a;
    smoothRot.y += (targetRot.y - smoothRot.y) * a;
    smoothRot.z += (targetRot.z - smoothRot.z) * a;
    aircraft.rotation.order = 'YXZ';
    aircraft.rotation.x = smoothRot.x;
    aircraft.rotation.y = smoothRot.y;
    aircraft.rotation.z = smoothRot.z;
  }

  if (aircraft && !chkTest.checked && socket && socket.readyState === WebSocket.OPEN) {
    const d = eulerToDisplayDeg();
    updateHud(d.pitch, d.roll, d.yaw);
  } else if (aircraft && chkTest.checked) {
    const d = eulerToDisplayDeg();
    updateHud(d.pitch, d.roll, d.yaw);
  } else if (aircraft && !chkTest.checked && (!socket || socket.readyState !== WebSocket.OPEN)) {
    const d = eulerToDisplayDeg();
    updateHud(d.pitch, d.roll, d.yaw);
  }

  followCamera(dt);
  controls.update();
  renderer.render(scene, camera);
}

animate();

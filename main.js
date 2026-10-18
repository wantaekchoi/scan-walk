import * as THREE from 'three';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { setupInput } from './input.js';

const EYE = 1.6, FLY = 3, CLIMB = 2; // eye height over the floor (m), forward and up/down speed (m/s)

const $ = id => document.getElementById(id);
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 2 });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// three shrinks bigger textures through a 2D canvas; iOS caps canvases at 4096² px, and an 8k map is ~350MB of GPU memory
renderer.capabilities.maxTextureSize = Math.min(renderer.capabilities.maxTextureSize, 4096);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(1, 2, 1.5);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
camera.rotation.order = 'YXZ';
const fix = new THREE.Group(); // manual axis/scale correction on top of the file's upAxis/metersPerUnit
scene.add(fix);

const input = setupInput(canvas, $('stick'));
const start = new THREE.Vector3(); // where the eye (the camera) starts
const bounds = new THREE.Box3();
let model = null, lit = false, axis = 0, scale = 0, saved = null;

// which file axis becomes up: rotation that maps it onto +Y
const AXES = [['+Y', 0, 0], ['+Z', -Math.PI / 2, 0], ['-Z', Math.PI / 2, 0], ['+X', 0, Math.PI / 2], ['-X', 0, -Math.PI / 2], ['-Y', Math.PI, 0]];
const SCALES = [1, 0.01, 100, 0.1, 10];

function busy(text) {
  $('busy').hidden = !text;
  $('busy-text').textContent = text || '';
}
const nextPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r)));
function say(text) { // short notice that doesn't cover the scan
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(say.t);
  say.t = setTimeout(() => ($('toast').hidden = true), 5000);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = e => e.lengthComputable && busy(`읽는 중 ${Math.round((e.loaded / e.total) * 100)}%`);
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

// file: File from the picker/drop (remembered on success) or the Blob already in IndexedDB (save = false)
async function open(file, save = true) {
  try {
    const buf = await readFile(file);
    busy('모델 해석 중');
    await nextPaint();
    const group = await new Promise((resolve, reject) => new USDLoader().parse(buf, '', resolve, reject));
    let meshes = 0;
    group.traverse(o => o.isMesh && meshes++);
    if (!meshes) throw new Error('메시가 없습니다');
    busy('바닥 찾는 중');
    await nextPaint();
    setModel(group);
    $('intro').hidden = true;
    busy(null);
    if (save) {
      mark(false); // picked another file instead of answering the "멈췄어요" prompt
      idb('readwrite', st => st.put(file, 'last')).then(() => { saved = file; $('forget').hidden = false; }, () => {});
    }
    return true;
  } catch (e) {
    console.warn(e);
    busy(null);
    const text = `열 수 없습니다: ${e.message || e}`;
    if (model) say(text); // keep showing the scan that is already open
    else {
      $('msg').textContent = text;
      $('intro').hidden = false;
    }
    return false;
  }
}

function setModel(group) {
  if (model) {
    fix.remove(model);
    model.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      o.userData.mats.flat().forEach(m => { m.map?.dispose(); m.dispose(); });
    });
  }
  const aniso = renderer.capabilities.getMaxAnisotropy();
  group.traverse(o => {
    if (!o.isMesh) return;
    const many = Array.isArray(o.material);
    const litMats = [o.material].flat();
    const flatMats = litMats.map(m => {
      m.side = THREE.DoubleSide; // scans are single-sided and full of holes
      if (!m.map && m.emissiveMap) { // 3D Scanner App: black diffuseColor and the photo on emissiveColor, which the lights would not shade
        m.map = m.emissiveMap;
        m.emissiveMap = null;
        m.color.set(0xffffff);
        m.emissive.set(0);
      }
      if (m.map) m.map.anisotropy = aniso;
      return new THREE.MeshBasicMaterial({
        map: m.map, color: m.color, vertexColors: m.vertexColors, side: THREE.DoubleSide,
        transparent: m.transparent, opacity: m.opacity,
      });
    });
    o.userData.mats = [many ? flatMats : flatMats[0], many ? litMats : litMats[0]];
    o.material = o.userData.mats[+lit];
  });
  model = group;
  fix.add(model);
  axis = scale = 0;
  rebuild();
}

// place the scan and find where to start, once per load / axis / scale change
function rebuild() {
  fix.rotation.set(AXES[axis][1], 0, AXES[axis][2]);
  fix.scale.setScalar(SCALES[scale]);
  fix.updateMatrixWorld(true);
  bounds.makeEmpty();
  const ys = [], ws = [];
  model.traverse(o => o.isMesh && heights(o, ys, ws));
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  // object, not a room: under ~2m (door height, two strides) across both ways, or narrow one way and low (a slide, a car)
  const object = Math.max(size.x, size.z) < 2 || (size.y < 2 && Math.min(size.x, size.z) < 2);
  const floor = object ? null : floorHeight(ys, ws);
  // object: its centre's height, backed off along +z (yaw 0 looks at it) until its bounding sphere fits the narrower FOV
  if (object) centre.z += size.length() / 2 / Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(camera.aspect, 1)));
  // a room: eye height over its floor, under the middle of the scan (holes don't matter, nothing blocks); no floor: the middle
  start.copy(centre);
  if (floor !== null) start.y = floor + EYE;
  $('axis').textContent = `축 ${AXES[axis][0]}`;
  $('scale').textContent = `×${SCALES[scale]}`;
  resetView();
}

function resetView() {
  camera.position.copy(start);
  input.yaw = input.pitch = 0;
}

// world-space heights for finding the floor, and the bounds: each triangle's middle, weighted by its area seen
// from above, so a wall counts for nothing and a floor counts the same however finely it is meshed
function heights(o, ys, ws) {
  const g = o.geometry, p = g.attributes.position, idx = g.index, v = new THREE.Vector3();
  const w = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).toArray(w, i * 3);
    bounds.expandByPoint(v);
  }
  const n = idx ? idx.count : p.count;
  for (let k = 0; k + 2 < n; k += 3) {
    const a = (idx ? idx.getX(k) : k) * 3, b = (idx ? idx.getX(k + 1) : k + 1) * 3, c = (idx ? idx.getX(k + 2) : k + 2) * 3;
    const area = Math.abs((w[b + 2] - w[a + 2]) * (w[c] - w[a]) - (w[b] - w[a]) * (w[c + 2] - w[a + 2])) / 2; // |cross.y| / 2
    if (area) { ys.push((w[a + 1] + w[b + 1] + w[c + 1]) / 3); ws.push(area); }
  }
}

// The floor: the lowest height layer (15cm) holding at least 30% of the heaviest one, in the lower half of the scan.
// Floor and ceiling are the two big horizontal layers and the ceiling is in the upper half; a bed or table top is smaller.
// null when there is none (walls and ceiling only).
const BIN = 0.05;
function floorHeight(ys, ws) {
  const lo = bounds.min.y, nb = Math.floor((bounds.max.y - lo) / BIN) + 1, h = new Float64Array(nb);
  ys.forEach((y, i) => { h[Math.min(nb - 1, Math.floor((y - lo) / BIN))] += ws[i]; });
  const win = i => (h[i - 1] || 0) + h[i] + (h[i + 1] || 0); // a noisy floor straddling two bins still counts whole
  let max = 0;
  for (let i = 0; i < nb; i++) max = Math.max(max, win(i));
  const mid = (bounds.min.y + bounds.max.y) / 2;
  for (let i = 0; i < nb && lo + i * BIN <= mid; i++) {
    if (!max || win(i) < 0.3 * max) continue;
    const y0 = lo + (i + 0.5) * BIN; // that layer's weighted mean height
    let s = 0, sw = 0;
    ys.forEach((y, k) => { if (Math.abs(y - y0) <= 1.5 * BIN) { s += y * ws[k]; sw += ws[k]; } });
    return s / sw;
  }
  return null;
}

// Free flight, nothing blocks (a viewer, not a game): forward goes where the camera looks, pitch included; sideways stays level.
// move: {x: right, y: forward} with length <= 1, up: -1..1 (keys).
// ponytail: no inertia, stops the moment the stick is let go; ease the speed if a glide is wanted
function fly(dt, move, up, yaw, pitch) {
  const s = Math.sin(yaw), c = Math.cos(yaw), ch = Math.cos(pitch), k = FLY * dt;
  camera.position.x += (move.x * c - move.y * ch * s) * k;
  camera.position.y += move.y * Math.sin(pitch) * k + up * CLIMB * dt;
  camera.position.z += (-move.x * s - move.y * ch * c) * k;
}

async function rebuildBusy() {
  busy('바닥 찾는 중');
  await nextPaint();
  rebuild();
  busy(null);
}

$('open').onclick = $('intro-open').onclick = () => $('file').click();
$('file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) open(f); };
$('light').onclick = () => {
  lit = !lit;
  $('light').setAttribute('aria-pressed', lit);
  model?.traverse(o => o.isMesh && (o.material = o.userData.mats[+lit]));
};
$('axis').onclick = () => { if (model) { axis = (axis + 1) % AXES.length; rebuildBusy(); } };
$('scale').onclick = () => { if (model) { scale = (scale + 1) % SCALES.length; rebuildBusy(); } };
$('reset').onclick = resetView;
$('forget').onclick = forget;
$('again-forget').onclick = () => { forget(); $('msg').textContent = ''; };
$('reopen').onclick = reopen;

// camera readout (좌표 / C): eye position in m, view angles in degrees; remembered, hidden at first
const hud = $('hud'), COORDS = 'scan-walk-coords';
let hudAt = -Infinity;
function showCoords(on) {
  hud.hidden = !on;
  $('coords').setAttribute('aria-pressed', on);
  hudAt = -Infinity; // write it on the next frame, not up to 100ms later
  try { on ? localStorage.setItem(COORDS, '1') : localStorage.removeItem(COORDS); } catch {}
}
try { showCoords(!!localStorage.getItem(COORDS)); } catch { showCoords(false); }
$('coords').onclick = () => showCoords(hud.hidden);
addEventListener('keydown', e => { if (e.code === 'KeyC' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) showCoords(hud.hidden); });

// a focused button would also fire on Space (fly up)
document.addEventListener('click', e => e.target.closest?.('button')?.blur());
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) open(f);
});
// iOS Safari ignores user-scalable=no; block pinch and rubber-band scrolling
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
// three asks the browser to restore the context; until then nothing can be drawn
canvas.addEventListener('webglcontextlost', () => {
  mark(true); // don't auto-reopen the saved scan next time without asking
  busy('그래픽 메모리가 모자라 화면을 잃었습니다. 안 돌아오면 페이지를 새로 고쳐 주세요.');
});
canvas.addEventListener('webglcontextrestored', () => { mark(false); busy(null); });

const timer = new THREE.Timer();
timer.connect(document); // no huge step after the tab was hidden
renderer.setAnimationLoop(t => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (model) {
    input.poll();
    fly(dt, input.move, input.up, input.yaw, input.pitch);
  }
  camera.rotation.set(input.pitch, input.yaw, 0);
  if (!hud.hidden && t - hudAt > 100) { // ~10Hz: a DOM write every frame is wasted on numbers nobody reads that fast
    hudAt = t;
    const p = camera.position, r = camera.rotation, deg = THREE.MathUtils.radToDeg;
    const f = (v, d) => (+v.toFixed(d) || 0).toFixed(d); // -0.001 reads 0.00, not -0.00
    hud.textContent = `x ${f(p.x, 2)}  y ${f(p.y, 2)}  z ${f(p.z, 2)} m\n` +
      `pitch ${f(deg(r.x), 1)}°  yaw ${f(THREE.MathUtils.euclideanModulo(deg(r.y) + 180, 360) - 180, 1)}°  roll ${f(deg(r.z), 1)}°`;
  }
  renderer.render(scene, camera);
});

// last opened file (the File itself, not its bytes); the app works the same when IndexedDB is missing or full
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('scan-walk', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', mode);
      const r = fn(tx.objectStore('files'));
      tx.oncomplete = () => { db.close(); resolve(r.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

window.app = { input, open, bounds, start, camera, fly }; // for tests and the console

// Set while reopening the saved scan, cleared once a few frames are drawn. Still there at start-up means
// that attempt killed the tab (usually memory), so ask instead of crashing in a loop.
const MARK = 'scan-walk-opening';
function mark(on) { try { on ? localStorage.setItem(MARK, '1') : localStorage.removeItem(MARK); } catch {} }
function marked() { try { return !!localStorage.getItem(MARK); } catch { return false; } }

async function reopen() {
  $('again').hidden = true;
  $('msg').textContent = '';
  mark(true);
  const ok = await open(saved, false);
  for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); // the first frames upload the textures
  mark(false);
  if (!ok) forget();
}

function forget() {
  saved = null;
  $('forget').hidden = $('again').hidden = true;
  mark(false);
  idb('readwrite', st => st.delete('last')).catch(() => {});
}

busy('지난 파일 확인 중');
idb('readonly', st => st.get('last'))
  .catch(() => null)
  .then(file => {
    busy(null);
    if (!(file instanceof Blob)) return;
    saved = file;
    $('forget').hidden = false;
    if (!marked()) return reopen();
    $('msg').textContent = `지난번에 저장된 스캔(${file.name || '이름 없음'})을 열다가 멈췄어요. 메모리가 모자랐을 수 있습니다.`;
    $('again').hidden = false;
  });

import * as THREE from 'three';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { setupInput } from './input.js';

const EYE = 1.6, FLY = 3, CLIMB = 2; // m over the floor, m/s, m/s
const POINT = 0.02; // m, drawn point diameter

const $ = id => document.getElementById(id);
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 2 });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// three resizes bigger textures through a 2D canvas, which iOS caps at 4096² px
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

const input = setupInput(canvas, [$('stick'), $('look')]);
const start = new THREE.Vector3(); // camera (eye) position
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
function say(text) {
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

// file: File from picker/drop, or the Blob from IndexedDB (save = false)
async function open(file, save = true) {
  try {
    const buf = await readFile(file);
    busy('모델 해석 중');
    await nextPaint();
    const ext = (file.name || '').toLowerCase().split('.').pop();
    const group = ext === 'xyz' ? points(parseXYZ(buf)) : ext === 'ply' ? ply(buf)
      : await new Promise((resolve, reject) => new USDLoader().parse(buf, '', resolve, reject));
    let parts = 0;
    group.traverse(o => (o.isMesh || o.isPoints) && parts++);
    if (!parts) throw new Error('메시가 없습니다');
    busy('바닥 찾는 중');
    await nextPaint();
    setModel(group);
    $('intro').hidden = true;
    busy(null);
    if (save) {
      mark(false);
      idb('readwrite', st => st.put(file, 'last')).then(() => { saved = file; $('forget').hidden = false; }, () => {});
    }
    return true;
  } catch (e) {
    console.warn(e);
    busy(null);
    const text = `열 수 없습니다: ${e.message || e}`;
    if (model) say(text);
    else {
      $('msg').textContent = text;
      $('intro').hidden = false;
    }
    return false;
  }
}

// sRGB byte -> linear byte, the same conversion PLYLoader applies
const LINEAR = new Uint8Array(256).map((_, v) => Math.round(new THREE.Color().setRGB(v / 255, 0, 0, THREE.SRGBColorSpace).r * 255));

// x,y,z[,r,g,b] per line, comma or space separated, colours 0-255
function parseXYZ(buf) {
  const b = new Uint8Array(buf), len = b.length;
  let lines = 1; // a lone \r ends a line too
  for (let i = 0; i < len; i++) if (b[i] === 10 || b[i] === 13) lines++;
  const pos = new Float32Array(lines * 3), col = new Uint8Array(lines * 3), row = new Float64Array(6);
  let n = 0, k = 0, colours = true;
  for (let i = 0; i <= len;) {
    const c = i < len ? b[i] : 10;
    if (c === 10 || c === 13) {
      if (k >= 3) {
        pos[n * 3] = row[0]; pos[n * 3 + 1] = row[1]; pos[n * 3 + 2] = row[2];
        if (k >= 6) for (let j = 0; j < 3; j++) col[n * 3 + j] = LINEAR[Math.min(255, Math.max(0, Math.round(row[3 + j])))];
        else colours = false;
        n++;
      }
      k = 0;
      i++;
    } else if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      const neg = c === 45;
      if (c === 45 || c === 43) i++;
      let m = 0, e = 0, dot = false;
      for (; i < len; i++) {
        const x = b[i];
        if (x >= 48 && x <= 57) { m = m * 10 + x - 48; if (dot) e--; }
        else if (x === 46 && !dot) dot = true;
        else break;
      }
      if (b[i] === 101 || b[i] === 69) {
        const en = b[++i] === 45;
        if (b[i] === 45 || b[i] === 43) i++;
        let ev = 0;
        for (; b[i] >= 48 && b[i] <= 57; i++) ev = ev * 10 + b[i] - 48;
        e += en ? -ev : ev;
      }
      const v = e < 0 ? m / 10 ** -e : m * 10 ** e;
      if (k >= 0 && k < 6) row[k] = neg ? -v : v;
      if (k >= 0) k++;
    } else {
      if (c !== 44 && c !== 32 && c !== 9) k = -1; // text: skip the line
      i++;
    }
  }
  if (!n) throw new Error('점이 없습니다');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, n * 3), 3));
  if (colours) g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, n * 3), 3, true));
  return g;
}

function ply(buf) {
  const g = new PLYLoader().parse(buf);
  g.deleteAttribute('normal');
  g.setIndex(null);
  return points(g);
}

function points(g) {
  finite(g);
  const group = new THREE.Group();
  // sizeAttenuation draws size * tan(fov / 2) world units across
  const size = POINT / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  group.add(new THREE.Points(g, new THREE.PointsMaterial({ size, vertexColors: !!g.attributes.color })));
  return group;
}

// a NaN point makes the bounding sphere NaN
function finite(g) {
  const p = g.attributes.position.array, keep = [];
  for (let i = 0; i < p.length; i += 3) if (Number.isFinite(p[i] + p[i + 1] + p[i + 2])) keep.push(i / 3);
  if (!keep.length) throw new Error('점이 없습니다');
  if (keep.length * 3 === p.length) return;
  for (const [name, a] of Object.entries(g.attributes)) {
    const out = new a.array.constructor(keep.length * a.itemSize);
    keep.forEach((v, j) => out.set(a.array.subarray(v * a.itemSize, (v + 1) * a.itemSize), j * a.itemSize));
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
  }
  g.boundingSphere = g.boundingBox = null; // PLYLoader computed them with the NaNs
}

function setModel(group) {
  if (model) {
    fix.remove(model);
    model.traverse(o => {
      if (o.isPoints) { o.geometry.dispose(); o.material.dispose(); }
      if (!o.isMesh) return;
      o.geometry.dispose();
      o.userData.mats.flat().forEach(m => { m.map?.dispose(); m.dispose(); });
    });
  }
  let meshes = 0;
  const aniso = renderer.capabilities.getMaxAnisotropy();
  group.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    const many = Array.isArray(o.material);
    const litMats = [o.material].flat();
    const flatMats = litMats.map(m => {
      m.side = THREE.DoubleSide;
      if (!m.map && m.emissiveMap) { // 3D Scanner App puts the texture on emissiveColor
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
  $('light').hidden = !meshes;
  model = group;
  fix.add(model);
  axis = scale = 0;
  rebuild();
}

function rebuild() {
  fix.rotation.set(AXES[axis][1], 0, AXES[axis][2]);
  fix.scale.setScalar(SCALES[scale]);
  fix.updateMatrixWorld(true);
  bounds.makeEmpty();
  const ys = [], ws = [], vy = [];
  model.traverse(o => (o.isMesh || o.isPoints) && heights(o, ys, ws, vy));
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const object = Math.max(size.x, size.z) < 2 || (size.y < 2 && Math.min(size.x, size.z) < 2);
  const floor = object ? null : floorHeight(ys, ws, vy);
  // back off along +z until the bounding sphere fits the narrower FOV
  if (object) centre.z += size.length() / 2 / Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(camera.aspect, 1)));
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

// ys/ws: triangle centre heights weighted by area seen from above, or point heights weighted 1; vy: all heights
function heights(o, ys, ws, vy) {
  const g = o.geometry, p = g.attributes.position, idx = g.index, v = new THREE.Vector3();
  const w = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).toArray(w, i * 3);
    if (!Number.isFinite(v.x + v.y + v.z)) continue;
    bounds.expandByPoint(v);
    vy.push(v.y);
    if (o.isPoints) { ys.push(v.y); ws.push(1); }
  }
  if (o.isPoints) return;
  const n = idx ? idx.count : p.count;
  for (let k = 0; k + 2 < n; k += 3) {
    const a = (idx ? idx.getX(k) : k) * 3, b = (idx ? idx.getX(k + 1) : k + 1) * 3, c = (idx ? idx.getX(k + 2) : k + 2) * 3;
    const area = Math.abs((w[b + 2] - w[a + 2]) * (w[c] - w[a]) - (w[b] - w[a]) * (w[c + 2] - w[a + 2])) / 2; // |cross.y| / 2
    if (area) { ys.push((w[a + 1] + w[b + 1] + w[c + 1]) / 3); ws.push(area); }
  }
}

// lowest 15cm layer in the lower half of the 1-99% height range holding >= 30% of that half's heaviest; null if none
const BIN = 0.05; // m
function floorHeight(ys, ws, vy) {
  const [lo, hi] = quantiles(vy, null, 0.01, 0.99), nb = Math.floor((hi - lo) / BIN) + 1, h = new Float64Array(nb);
  ys.forEach((y, i) => { if (y >= lo && y <= hi) h[Math.min(nb - 1, Math.floor((y - lo) / BIN))] += ws[i]; });
  const win = i => (h[i - 1] || 0) + h[i] + (h[i + 1] || 0);
  const mid = (lo + hi) / 2, below = Math.floor((mid - lo) / BIN) + 1;
  let max = 0;
  for (let i = 0; i < below; i++) max = Math.max(max, win(i));
  for (let i = 0; i < below; i++) {
    if (!max || win(i) < 0.3 * max) continue;
    const y0 = lo + (i + 0.5) * BIN;
    let s = 0, sw = 0;
    ys.forEach((y, k) => { if (Math.abs(y - y0) <= 1.5 * BIN) { s += y * ws[k]; sw += ws[k]; } });
    return s / sw;
  }
  return null;
}

// histogram quantiles, resolution (max - min) / 65535; ws null = weight 1
function quantiles(ys, ws, ...qs) {
  let lo = Infinity, hi = -Infinity, total = 0;
  ys.forEach((y, i) => { lo = Math.min(lo, y); hi = Math.max(hi, y); total += ws ? ws[i] : 1; });
  const N = 65536, h = new Float64Array(N), s = (N - 1) / (hi - lo || 1);
  ys.forEach((y, i) => { h[((y - lo) * s) | 0] += ws ? ws[i] : 1; });
  return qs.map(q => {
    let acc = 0, i = 0;
    while (i < N - 1 && (acc += h[i]) < q * total) i++;
    return lo + i / s;
  });
}

// move: {x: right, y: forward}, length <= 1; up: -1..1; yaw/pitch: rad
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

const hud = $('hud'), COORDS = 'scan-walk-coords';
let hudAt = -Infinity;
function showCoords(on) {
  hud.hidden = !on;
  $('coords').setAttribute('aria-pressed', on);
  hudAt = -Infinity;
  try { on ? localStorage.setItem(COORDS, '1') : localStorage.removeItem(COORDS); } catch {}
}
try { showCoords(!!localStorage.getItem(COORDS)); } catch { showCoords(false); }
$('coords').onclick = () => showCoords(hud.hidden);
addEventListener('keydown', e => { if (e.code === 'KeyC' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) showCoords(hud.hidden); });

// a focused button would also fire on Space
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
canvas.addEventListener('webglcontextlost', () => {
  mark(true);
  busy('그래픽 메모리가 모자라 화면을 잃었습니다. 안 돌아오면 페이지를 새로 고쳐 주세요.');
});
canvas.addEventListener('webglcontextrestored', () => { mark(false); busy(null); });

const timer = new THREE.Timer();
timer.connect(document); // no huge dt after a hidden tab
renderer.setAnimationLoop(t => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (model) {
    input.poll(dt);
    fly(dt, input.move, input.up, input.yaw, input.pitch);
  }
  camera.rotation.set(input.pitch, input.yaw, 0);
  if (!hud.hidden && t - hudAt > 100) { // ms
    hudAt = t;
    const p = camera.position, r = camera.rotation, deg = THREE.MathUtils.radToDeg;
    const f = (v, d) => (+v.toFixed(d) || 0).toFixed(d); // -0.001 reads 0.00, not -0.00
    hud.textContent = `x ${f(p.x, 2)}  y ${f(p.y, 2)}  z ${f(p.z, 2)} m\n` +
      `pitch ${f(deg(r.x), 1)}°  yaw ${f(THREE.MathUtils.euclideanModulo(deg(r.y) + 180, 360) - 180, 1)}°  roll ${f(deg(r.z), 1)}°`;
  }
  renderer.render(scene, camera);
});

// the last opened File; IndexedDB may be missing or full
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

window.app = { input, open, bounds, start, camera, fly, get model() { return model; } }; // for tests

// set while reopening; still set at start-up = that reopen killed the tab
const MARK = 'scan-walk-opening';
function mark(on) { try { on ? localStorage.setItem(MARK, '1') : localStorage.removeItem(MARK); } catch {} }
function marked() { try { return !!localStorage.getItem(MARK); } catch { return false; } }

async function reopen() {
  $('again').hidden = true;
  $('msg').textContent = '';
  mark(true);
  const ok = await open(saved, false);
  for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); // texture upload happens in the first frames
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

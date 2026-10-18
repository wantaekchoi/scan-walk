import * as THREE from 'three';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';
import { Player, EYE } from './player.js';
import { setupInput } from './input.js';

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

const player = new Player();
const input = setupInput(canvas, $('stick'), teleport);
const start = new THREE.Vector3();
const bounds = new THREE.Box3();
const raycaster = new THREE.Raycaster();
let model = null, lit = false, axis = 0, scale = 0, startOnFloor = true, saved = null;

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
    busy('충돌 계산 중');
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

// bake the world-space collider and BVH once per load / axis / scale change
function rebuild() {
  fix.rotation.set(AXES[axis][1], 0, AXES[axis][2]);
  fix.scale.setScalar(SCALES[scale]);
  fix.updateMatrixWorld(true);
  const gen = new StaticGeometryGenerator(model);
  gen.attributes = ['position'];
  const geom = gen.generate();
  player.bvh = new MeshBVH(geom);
  geom.computeBoundingBox();
  bounds.copy(geom.boundingBox);
  // start: the floor nearest below the bounding box centre, or flying with the eye at the centre when there is none
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  // object, not a room: under ~2m (door height, two strides) across both ways, or narrow one way and low (a slide, a car)
  const object = Math.max(size.x, size.z) < 2 || (size.y < 2 && Math.min(size.x, size.z) < 2);
  const hit = !object && startFloor(centre, size);
  startOnFloor = !!hit;
  // object: fly at its centre's height, backed off along +z (yaw 0 looks at it) until its bounding sphere fits the narrower FOV
  if (object) centre.z += size.length() / 2 / Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(camera.aspect, 1)));
  start.copy(hit ? hit.point : centre.setY(centre.y - EYE));
  $('axis').textContent = `축 ${AXES[axis][0]}`;
  $('scale').textContent = `×${SCALES[scale]}`;
  resetView();
}

function resetView() {
  player.pos.copy(start);
  player.vy = 0;
  player.grounded = false;
  player.lastFloor = startOnFloor ? start.clone() : null;
  setFly(!startOnFloor); // ▲ makes flying common: 처음 also lands a room scan back in walk mode
  input.yaw = input.pitch = 0;
}

async function rebuildBusy() {
  busy('충돌 계산 중');
  await nextPaint();
  rebuild();
  busy(null);
}

// first floor along the ray: a face turned up, with the eye still under the top of the scan
// (else the first one turned up: a scan lower than the eye, a terrace or a floor only, has no headroom anywhere)
function floorAlong(ray) {
  for (let near = 0, low = null; ;) {
    const hit = player.bvh.raycastFirst(ray, THREE.DoubleSide, near);
    if (!hit) return low;
    const n = hit.face.normal;
    if (n.dot(ray.direction) > 0) n.negate();
    if (n.y < 0.5) return null; // floors only
    if (hit.point.y + EYE <= bounds.max.y) return hit;
    low ??= hit;
    near = hit.distance + 0.01; // no headroom (top of the ceiling after an accidental ▲, top of an object): look past it
  }
}

// straight down from the centre, else from a 33x33 grid over the scan, nearest the centre first:
// real scans have holes, and a bit scanned through a window moves the box centre off the floor
function startFloor(centre, size) {
  const ray = new THREE.Ray(centre.clone(), new THREE.Vector3(0, -1, 0));
  const pts = [];
  for (let i = 0; i <= 32; i++) for (let j = 0; j <= 32; j++) pts.push([(i / 32 - 0.5) * size.x, (j / 32 - 0.5) * size.z]);
  pts.sort((a, b) => Math.hypot(...a) - Math.hypot(...b)); // [0, 0] first
  for (const [dx, dz] of pts) {
    ray.origin.set(centre.x + dx, centre.y, centre.z + dz);
    const hit = floorAlong(ray);
    if (hit) return hit;
  }
  return null;
}

function teleport(x, y) {
  if (!player.bvh) return;
  raycaster.setFromCamera({ x: (x / innerWidth) * 2 - 1, y: -(y / innerHeight) * 2 + 1 }, camera);
  const hit = floorAlong(raycaster.ray);
  if (!hit) return;
  player.pos.copy(hit.point);
  player.vy = 0;
  player.grounded = false;
  setFly(false); // double-tap while flying = land there, the way back from an accidental ▲
}

function setFly(on) {
  player.fly = on;
  $('mode').textContent = on ? '비행' : '걷기';
  document.body.classList.toggle('fly', on);
}

$('open').onclick = $('intro-open').onclick = () => $('file').click();
$('file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) open(f); };
$('mode').onclick = () => setFly(!player.fly);
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
for (const [id, dir] of [['up', 1], ['down', -1]]) {
  const b = $(id);
  b.onpointerdown = e => { b.setPointerCapture(e.pointerId); input.buttonUp = dir; };
  b.onpointerup = b.onpointercancel = () => { input.buttonUp = 0; };
}

// a focused button would also fire on Space (take off / fly up)
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
  if (player.bvh) {
    input.poll();
    if (input.up > 0 && !player.fly) setFly(true); // ▲ / Space while walking takes off
    player.update(dt, input.move, input.up, input.yaw, input.pitch);
    if (player.pos.y < bounds.min.y - 10) { // fell through a hole: back to where we last stood
      if (player.lastFloor) {
        player.pos.copy(player.lastFloor);
        player.vy = 0;
        player.grounded = false;
      } else resetView();
    }
  }
  camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  camera.rotation.set(input.pitch, input.yaw, 0);
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

window.app = { player, input, open, bounds, start, camera }; // for tests and the console

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

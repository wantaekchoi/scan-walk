import * as THREE from 'three';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';
import { Player, EYE } from './player.js';
import { setupInput } from './input.js';

const $ = id => document.getElementById(id);
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 2 });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
let model = null, lit = false, axis = 0, scale = 0;

// which file axis becomes up: rotation that maps it onto +Y
const AXES = [['+Y', 0, 0], ['+Z', -Math.PI / 2, 0], ['-Z', Math.PI / 2, 0], ['+X', 0, Math.PI / 2], ['-X', 0, -Math.PI / 2], ['-Y', Math.PI, 0]];
const SCALES = [1, 0.01, 100, 0.1, 10];

function busy(text) {
  $('busy').hidden = !text;
  $('busy-text').textContent = text || '';
}
const nextPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r)));

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = e => e.lengthComputable && busy(`읽는 중 ${Math.round((e.loaded / e.total) * 100)}%`);
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

// open(File) from the picker/drop, or open(name, ArrayBuffer) from IndexedDB
async function open(file, buf) {
  const name = buf ? file : file.name;
  try {
    buf ??= await readFile(file);
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
    idb('readwrite', st => st.put({ name, buf }, 'last')).catch(() => {});
    return true;
  } catch (e) {
    console.warn(e);
    busy(null);
    $('intro').hidden = false;
    $('msg').textContent = `열 수 없습니다: ${e.message || e}`;
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
  // start: floor under the bounding box centre
  bounds.getCenter(raycaster.ray.origin);
  raycaster.ray.direction.set(0, -1, 0);
  const hit = player.bvh.raycastFirst(raycaster.ray, THREE.DoubleSide);
  start.copy(hit ? hit.point : raycaster.ray.origin.setY(bounds.min.y));
  $('axis').textContent = `축 ${AXES[axis][0]}`;
  $('scale').textContent = `×${SCALES[scale]}`;
  resetView();
}

function resetView() {
  player.pos.copy(start);
  player.vy = 0;
  player.grounded = false;
  input.yaw = input.pitch = 0;
}

function teleport(x, y) {
  if (!player.bvh) return;
  raycaster.setFromCamera({ x: (x / innerWidth) * 2 - 1, y: -(y / innerHeight) * 2 + 1 }, camera);
  const hit = player.bvh.raycastFirst(raycaster.ray, THREE.DoubleSide);
  if (!hit) return;
  const n = hit.face.normal;
  if (n.dot(raycaster.ray.direction) > 0) n.negate();
  if (n.y < 0.5) return; // floors only
  player.pos.copy(hit.point);
  player.vy = 0;
  player.grounded = false;
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
$('axis').onclick = () => { if (model) { axis = (axis + 1) % AXES.length; rebuild(); } };
$('scale').onclick = () => { if (model) { scale = (scale + 1) % SCALES.length; rebuild(); } };
$('reset').onclick = resetView;
for (const [id, dir] of [['up', 1], ['down', -1]]) {
  const b = $(id);
  b.onpointerdown = e => { b.setPointerCapture(e.pointerId); input.buttonUp = dir; };
  b.onpointerup = b.onpointercancel = () => { input.buttonUp = 0; };
}

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

const timer = new THREE.Timer();
timer.connect(document); // no huge step after the tab was hidden
renderer.setAnimationLoop(t => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (player.bvh) {
    input.poll();
    player.update(dt, input.move, input.up, input.yaw);
    if (player.pos.y < bounds.min.y - 10) resetView(); // fell through a hole
  }
  camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  camera.rotation.set(input.pitch, input.yaw, 0);
  renderer.render(scene, camera);
});

// last opened file; the app works the same when IndexedDB is missing or full
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

window.app = { player, input, open, bounds, start }; // for tests and the console

busy('지난 파일 확인 중');
idb('readonly', st => st.get('last'))
  .catch(() => null)
  .then(async last => {
    busy(null);
    if (last?.buf && !(await open(last.name, last.buf))) idb('readwrite', st => st.delete('last')).catch(() => {});
  });

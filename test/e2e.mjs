// e2e in headless Chromium (Playwright).
//   python test/make_room.py /tmp/rooms && python3 -m http.server 8765 &
//   ASSETS=/tmp/rooms node test/e2e.mjs
// env: ASSETS (make_room.py output, required), BASE_URL (default http://127.0.0.1:8765/),
//      SHOTS (screenshot dir, optional), CHROMIUM (browser executable, optional),
//      PLAYWRIGHT (path to playwright's index.mjs when it isn't installed next to this repo)
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const A = process.env.ASSETS;
if (!A) throw new Error('set ASSETS to the folder made by test/make_room.py');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const SHOTS = process.env.SHOTS;
const LOADER_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/loaders/USDLoader.js';

const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(detail)); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });

async function newPage(opts, setup) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [], warnings = [];
  page.on('console', m => {
    if (m.text().includes('GL Driver Message')) return; // SwiftShader noise from screenshots
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  if (setup) await setup(page);
  await page.goto(BASE);
  return { ctx, page, errors, warnings };
}
const idle = page => page.waitForFunction(() => window.app && document.getElementById('busy').hidden, null, { timeout: 30000 });
const loaded = (page, timeout = 30000) => page.waitForFunction(() => window.app && !window.app.bounds.isEmpty() && document.getElementById('busy').hidden && document.getElementById('intro').hidden, null, { timeout });
async function load(page, file) {
  await page.evaluate(() => window.app?.bounds.makeEmpty());
  await page.setInputFiles('#file', `${A}/${file}`);
  await loaded(page, 10000).catch(() => console.log('(not opened:', file, ')')); // FAIL the checks, don't abort
  await page.waitForTimeout(300);
}
async function click(page, sel) { await page.click(sel); await idle(page); } // axis/scale rebuild behind the busy overlay
const state = page => page.evaluate(() => {
  const { camera, input, bounds, start } = window.app;
  const r = v => +v.toFixed(3);
  return { pos: camera.position.toArray().map(r), yaw: r(input.yaw), pitch: r(input.pitch),
    size: bounds.getSize(bounds.min.clone()).toArray().map(r), centre: bounds.getCenter(bounds.min.clone()).toArray().map(r), start: start.toArray().map(r) };
});
const hud = page => page.evaluate(() => {
  const e = document.getElementById('hud'), { position: p, rotation: r } = window.app.camera, deg = v => v * 180 / Math.PI;
  return { shown: !!e && !e.hidden && e.getBoundingClientRect().height > 0, text: e?.textContent, n: (e?.textContent.match(/-?\d+(\.\d+)?/g) || []).map(Number),
    cam: [p.x, p.y, p.z, deg(r.x), ((deg(r.y) + 180) % 360 + 360) % 360 - 180, deg(r.z)], pressed: document.getElementById('coords')?.getAttribute('aria-pressed') };
});
const hudMatches = h => h.n.length === 6 && h.n.every((v, i) => near(v, h.cam[i], i < 3 ? 0.006 : 0.06));
// x, y, z: camera position
const place = (page, x, y, z, yaw = 0, pitch = 0) => page.evaluate(([x, y, z, yaw, pitch]) => {
  const { camera, input } = window.app;
  camera.position.set(x, y, z); input.yaw = yaw; input.pitch = pitch;
}, [x, y, z, yaw, pitch]);
async function hold(page, key, ms) { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); await page.waitForTimeout(150); }
const saved = page => page.evaluate(() => new Promise(res => {
  const req = indexedDB.open('scan-walk', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('files');
  req.onsuccess = () => {
    const g = req.result.transaction('files').objectStore('files').get('last');
    g.onsuccess = () => { const v = g.result; req.result.close(); res(v ? { blob: v instanceof Blob, name: v.name, size: v.size } : null); };
  };
}));
const marker = page => page.evaluate(() => localStorage.getItem('scan-walk-opening'));
// mean RGB of the canvas; background 0x111111 = 17
const brightness = page => page.evaluate(() => new Promise(res => requestAnimationFrame(() => {
  const g = document.createElement('canvas').getContext('2d');
  g.canvas.width = g.canvas.height = 64;
  g.drawImage(document.getElementById('c'), 0, 0, 64, 64);
  const px = g.getImageData(0, 0, 64, 64).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
  res(Math.round(sum / 3 / 4096));
})));
async function objectView(page, tag, file = 'object.usdz') {
  await load(page, file);
  const s = await state(page);
  const v = await page.evaluate(() => new Promise(res => requestAnimationFrame(() => { // right after the app's render, before the frame is cleared
    const { bounds, camera } = window.app, { min, max } = bounds;
    const pts = [0, 1, 2, 3, 4, 5, 6, 7].map(i => min.clone().set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
    pts.push(bounds.getCenter(min.clone()));
    const inView = pts.every(p => { p.project(camera); return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) < 1; });
    const g = document.createElement('canvas').getContext('2d');
    g.canvas.width = g.canvas.height = 64;
    g.drawImage(document.getElementById('c'), 0, 0, 64, 64);
    const px = g.getImageData(0, 0, 64, 64).data;
    let fg = 0;
    for (let i = 0; i < px.length; i += 4) fg += Math.abs(px[i] - 17) + Math.abs(px[i + 1] - 17) + Math.abs(px[i + 2] - 17) > 30;
    res({ inView, outside: !bounds.containsPoint(camera.position), drawn: +(fg / 4096).toFixed(3) });
  })));
  check(`${tag}: object scan starts outside, all in view`, v.inView && v.outside && v.drawn > 0.05, { ...v, pos: s.pos, centre: s.centre });
  await shot(page, `${tag}-object`);
  await place(page, 3, 1, 3, 1, -0.5);
  await click(page, '#reset');
  const r = await state(page);
  check(`${tag}: 처음 returns to the same object view`, ['pos', 'yaw', 'pitch'].every(k => `${r[k]}` === `${s[k]}`), { start: s, reset: r });
}

// ---------- desktop ----------
{
  const { page, errors, warnings } = await newPage({ viewport: { width: 1280, height: 800 } });
  await idle(page);
  await shot(page, 'd0-intro');
  await load(page, 'room_y.usdz');
  let s = await state(page);
  check('room_y: start 1.6m over floor, bbox centre', near(s.start[0], 0, 0.01) && near(s.start[1], 1.6, 0.01) && near(s.start[2], 0.75, 0.01) && `${s.pos}` === `${s.start}`, s);
  check('always flying: no walk/fly button', !(await page.$('#mode')), null);
  check('room_y size 6 x 2.6 x 6.5', near(s.size[0], 6, 0.01) && near(s.size[1], 2.6, 0.01) && near(s.size[2], 6.5, 0.01), s.size);
  await page.waitForSelector('#forget', { state: 'visible' });
  const sv = await saved(page);
  check('IndexedDB keeps the File itself (not its bytes)', sv?.blob && sv.name === 'room_y.usdz' && sv.size === 6178, sv);
  await shot(page, 'd1-loaded-unlit');

  const pitched = await page.evaluate(() => {
    const { camera: c, start } = window.app, r = v => +v.toFixed(4), out = {};
    for (const [name, pitch] of [['up', 0.6], ['down', -0.6]]) {
      c.position.set(0, 2.6, 0.75);
      for (let i = 0; i < 60; i++) window.app.fly?.(1 / 60, { x: 0, y: 1 }, 0, 0, pitch);
      out[name] = { dy: r(c.position.y - 2.6), dz: r(c.position.z - 0.75) };
    }
    c.position.copy(start);
    return out;
  });
  check('fly: forward follows the view pitch, up and down', near(pitched.up.dy, 3 * Math.sin(0.6), 0.01) && near(pitched.down.dy, -3 * Math.sin(0.6), 0.01) &&
    [pitched.up, pitched.down].every(m => near(m.dz, -3 * Math.cos(0.6), 0.01)), pitched);

  const descents = await page.evaluate(() => {
    const { camera: c, start } = window.app, r = v => +v.toFixed(3), out = {};
    for (const [name, x, y, z, yaw, fwd, up, n] of [['stepLevel', -0.5, 1.6, -1.5, Math.PI / 2, 1, 0, 30], ['ceiling', 0, 4.5, 0.75, 0, 0, -1, 120]]) {
      c.position.set(x, y, z);
      for (let i = 0; i < n; i++) window.app.fly?.(1 / 60, { x: 0, y: fwd }, up, yaw, 0);
      out[name] = c.position.toArray().map(r);
    }
    c.position.copy(start);
    return out;
  });
  check('fly level through the step', near(descents.stepLevel[1], 1.6, 0.01) && near(descents.stepLevel[0], -2, 0.01), descents.stepLevel);
  check('fly down through ceiling and floor', near(descents.ceiling[1], 0.5, 0.01), descents.ceiling);

  await place(page, 0, -10.4, 0.75);
  await page.waitForTimeout(300);
  s = await state(page);
  check('12m under the scan: stays there, no snap back', near(s.pos[1], -10.4, 0.01), s.pos);

  await click(page, '#reset');
  await hold(page, 'KeyW', 2500);
  s = await state(page);
  check('W passes through the -z wall', s.pos[2] < -2.6, s.pos);
  const y0 = s.pos[1];
  await hold(page, 'Space', 600);
  s = await state(page);
  check('Space rises and does not re-trigger the clicked button', s.pos[1] > y0 + 0.5, { y0, y: s.pos[1] });
  await shot(page, 'd4-fly-outside');
  await place(page, 0, 2.6, 0.75, 0, 0.6);
  await hold(page, 'KeyW', 1000);
  s = await state(page);
  check('W with the view tilted up climbs along the view', s.pos[1] > 3.4 && s.pos[2] < -1, s.pos);
  await click(page, '#reset');
  s = await state(page);
  check('room scan: 처음 returns to the start', `${s.pos}` === `${s.start}` && s.yaw === 0 && s.pitch === 0, s);
  const hudOff = await hud(page);
  await hold(page, 'KeyC', 50);
  const hudOn = await hud(page);
  await hold(page, 'KeyC', 50);
  check('desktop: C toggles the camera readout, hidden at first', !hudOff.shown && hudOn.shown && hudMatches(hudOn) && !(await hud(page)).shown, { hudOff, hudOn });
  await hold(page, 'KeyC', 50);
  const combos = {};
  for (const k of ['Meta+KeyC', 'Control+KeyC', 'Alt+KeyC']) { // each on its own: two toggles would cancel out
    await page.keyboard.press(k);
    await page.waitForTimeout(150);
    combos[k] = (await hud(page)).shown;
  }
  check('desktop: ⌘C / Ctrl+C / Alt+C leave the readout alone', Object.values(combos).every(Boolean), combos);
  await place(page, -0.001, 0, 0.75, 4, -0.0001);
  await page.waitForTimeout(250);
  const hEdge = await hud(page);
  await hold(page, 'KeyC', 50);
  check('desktop: readout wraps yaw to ±180 and shows no -0', near(hEdge.n[4], -130.8, 0.06) && !/-0\.0+(?![0-9])/.test(hEdge.text), hEdge.text);

  await place(page, 0, 0, 0.75, 0, -0.5);
  await page.waitForTimeout(200);
  const before = (await state(page)).pos;
  await page.mouse.dblclick(500, 620);
  await page.waitForTimeout(300);
  s = await state(page);
  await page.evaluate(() => document.exitPointerLock?.());
  check('double-click on the floor does not move you', `${s.pos}` === `${before}`, { before, after: s.pos });

  await click(page, '#light');
  await click(page, '#reset');
  await page.waitForTimeout(300);
  await shot(page, 'd5-lit');
  await click(page, '#light');

  await objectView(page, 'desktop');
  await load(page, 'room_z.usdz');
  s = await state(page);
  check('room_z (upAxis Z): upright, start 1.6m over floor', near(s.size[1], 2.6, 0.01) && near(s.start[1], 1.6, 0.01), s);

  await load(page, 'room_z_mislabeled.usdz');
  s = await state(page);
  check('mislabeled Z-up lies on its side (y extent 6.5)', near(s.size[1], 6.5, 0.01), s.size);
  await shot(page, 'd6-mislabeled');
  await click(page, '#axis');
  s = await state(page);
  const axisLabel = await page.textContent('#axis');
  check('axis +Z fixes mislabeled scan', near(s.size[1], 2.6, 0.01) && near(s.start[1], 1.6, 0.01) && axisLabel.includes('+Z'), { s, axisLabel });
  await click(page, '#reset');
  await page.waitForTimeout(300);
  await shot(page, 'd7-mislabeled-fixed');

  await load(page, 'room_cm.usdz');
  s = await state(page);
  check('room_cm (metersPerUnit 0.01) is 6m wide', near(s.size[0], 6, 0.01), s.size);
  await page.click('#scale');
  const busyShown = await page.evaluate(() => !document.getElementById('busy').hidden);
  await idle(page);
  s = await state(page);
  check('scale button shows busy, then x0.01', busyShown && near(s.size[0], 0.06, 0.001) && (await page.textContent('#scale')) === '×0.01', { busyShown, size: s.size });
  for (let i = 0; i < 4; i++) await click(page, '#scale');
  s = await state(page);
  check('scale cycle returns to x1', near(s.size[0], 6, 0.01), s.size);

  await load(page, 'room_nofloor.usdz');
  s = await state(page);
  check('no floor: start at bbox centre', near(s.start[1], s.centre[1], 0.01), s);

  await load(page, 'room_flat.usdz');
  s = await state(page);
  check('floor only, lower than eye height: starts 1.6m over it', near(s.start[1], 1.6, 0.02), s);
  await load(page, 'room_scanner.usdz');
  s = await state(page);
  const off = +Math.hypot(s.start[0] - s.centre[0], s.start[2] - s.centre[2]).toFixed(3);
  check('scanner export, hole under centre: start 1.6m over floor', near(s.start[1], 1.6, 0.02) && off < 0.01, { ...s, off });
  const holeDown = await page.evaluate(() => {
    const { camera: c, bounds: b, start } = window.app, m = b.getCenter(b.min.clone());
    c.position.set(m.x, 2.1, m.z);
    for (let i = 0; i < 150; i++) window.app.fly?.(1 / 60, { x: 0, y: 0 }, -1, 0, 0);
    const out = { y: +c.position.y.toFixed(3), bottom: +b.min.y.toFixed(3) };
    c.position.copy(start);
    return out;
  });
  check('scanner export: fly down through the hole', near(holeDown.y, -2.9, 0.01) && holeDown.y < holeDown.bottom - 2.5, holeDown);
  const unlit = await brightness(page);
  await shot(page, 'd6b-scanner-unlit');
  await click(page, '#light');
  const lit = await brightness(page);
  await click(page, '#light');
  check('scanner export: emissive texture drawn, unlit and lit', unlit > 60 && lit > 60, { unlit, lit, background: 17 });

  await load(page, 'room_8k.usdz');
  await page.waitForTimeout(500);
  const resized = warnings.filter(w => w.includes('Texture has been resized from (8192x8192) to (4096x4096)'));
  check('8192px texture is uploaded at 4096', resized.length === 1, resized);

  const cleared = page => page.waitForFunction(() => localStorage.getItem('scan-walk-opening') === null, null, { timeout: 20000 }).then(() => true, () => false);
  await page.reload();
  await loaded(page);
  s = await state(page);
  check('reload reopens last file, clears marker', near(s.size[0], 6, 0.01) && await cleared(page), s.size);

  await page.evaluate(() => localStorage.setItem('scan-walk-opening', '1'));
  await page.reload();
  await idle(page);
  await page.waitForTimeout(1000);
  const prompt = await page.evaluate(() => ({ again: !document.getElementById('again').hidden, msg: document.getElementById('msg').textContent, model: !window.app.bounds.isEmpty() }));
  check('crash marker at start-up: asks instead of reopening', prompt.again && prompt.msg.includes('멈췄어요') && !prompt.model, prompt);
  await shot(page, 'd8-crash-prompt');
  await page.click('#reopen');
  await loaded(page);
  check('"다시 열기" opens it and clears the marker', await cleared(page), await marker(page));

  await page.evaluate(() => localStorage.setItem('scan-walk-opening', '1'));
  await page.reload();
  await idle(page);
  await page.waitForSelector('#again', { state: 'visible' });
  await load(page, 'room_z.usdz');
  check('another file at the prompt: marker cleared, saved', (await marker(page)) === null && (await saved(page))?.name === 'room_z.usdz', await saved(page));

  await page.evaluate(() => localStorage.setItem('scan-walk-opening', '1'));
  await page.reload();
  await idle(page);
  await page.waitForSelector('#again-forget', { state: 'visible' });
  await page.click('#again-forget');
  await page.waitForTimeout(300);
  check('"잊기" in the prompt deletes the saved scan', (await saved(page)) === null && (await marker(page)) === null, await saved(page));
  await page.reload();
  await idle(page);
  await page.waitForTimeout(500);
  check('nothing saved: start-up shows the intro', await page.evaluate(() => !document.getElementById('intro').hidden && window.app.bounds.isEmpty()), null);

  await load(page, 'room_y.usdz');
  await page.waitForSelector('#forget', { state: 'visible' });
  await page.click('#forget');
  await page.waitForTimeout(300);
  check('"잊기" bar button deletes the saved scan and hides', (await saved(page)) === null && await page.isHidden('#forget'), null);

  await page.setInputFiles('#file', { name: 'x.usdz', mimeType: 'application/octet-stream', buffer: Buffer.from('not a usdz') });
  await page.waitForSelector('#toast', { state: 'visible' });
  const t = await page.evaluate(() => ({ toast: document.getElementById('toast').textContent, intro: !document.getElementById('intro').hidden, model: !window.app.bounds.isEmpty() }));
  check('bad file while a scan is open: message only, scan stays', t.toast.includes('열 수 없습니다') && !t.intro && t.model, t);
  await shot(page, 'd9-toast');

  await page.evaluate(() => { window.__lose = document.getElementById('c').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
  await page.waitForTimeout(300);
  const lost = await page.evaluate(() => ({ busy: !document.getElementById('busy').hidden, text: document.getElementById('busy-text').textContent }));
  await page.evaluate(() => window.__lose.restoreContext());
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => document.getElementById('busy').hidden);
  check('WebGL context lost: notice shown, removed on restore', lost.busy && lost.text.includes('그래픽') && back, { lost, back });

  const unexpected = warnings.filter(w => !w.includes('Texture has been resized') && !w.includes('메시가 없습니다') && !w.includes('USDAParser'));
  check('desktop: no console errors or unexpected warnings', errors.length === 0 && unexpected.length === 0, { errors, unexpected });
  await page.context().close();
}

// ---------- point clouds ----------
{
  const { page, errors, warnings } = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await idle(page);
  const fs = await import('node:fs');
  const lines = f => fs.readFileSync(`${A}/${f}`, 'latin1').split('\n').filter(l => l.trim()).length;
  const cloud = () => page.evaluate(() => {
    let o = null;
    window.app.model?.traverse(x => { if (x.isPoints) o = x; });
    if (!o) return null;
    const c = o.geometry.attributes.color;
    let h = 0;
    if (c) for (const v of c.array) h = (h * 31 + v) >>> 0;
    return { n: o.geometry.attributes.position.count, color: !!c, hash: h, size: o.material.size, atten: o.material.sizeAttenuation, normals: !!o.geometry.attributes.normal };
  });
  await load(page, 'room.xyz');
  let s = await state(page);
  const xyz = await cloud(), xyzPx = await brightness(page);
  await shot(page, 'p1-room-xyz');
  check('xyz: every line is a point, with colours', xyz?.n === lines('room.xyz') && xyz.color, xyz);
  const drawn = xyz && +(xyz.size * Math.tan(35 * Math.PI / 180)).toFixed(4); // drawn diameter at fov 70
  check('xyz: points 2cm across', xyz?.atten && near(drawn, 0.02, 0.0005), { drawn, ...xyz });
  check('xyz: start 1.6m over floor, centre', near(s.start[1], 1.6, 0.03) && near(s.start[0], s.centre[0], 0.01) && near(s.start[2], s.centre[2], 0.01), s);
  check('xyz: no 조명 button for points (they are not lit)', await page.isHidden('#light'), null);
  const sv = await saved(page);
  check('xyz: remembered in IndexedDB', sv?.name === 'room.xyz', sv);

  await load(page, 'room.ply');
  const ply = await cloud(), plyPx = await brightness(page);
  s = await state(page);
  check('ply (PCL ascii + camera element): all vertices, no normals', ply?.n === lines('room.xyz') && ply.color && !ply.normals, ply);
  check('the same scan as xyz and ply: same colours, same pixels', ply?.hash === xyz?.hash && xyzPx === plyPx && xyzPx > 25, { xyz: xyz?.hash, ply: ply?.hash, xyzPx, plyPx });
  check('ply: same start as xyz', near(s.start[1], 1.6, 0.03), s.start);

  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  await page.click('#coords', { timeout: 2000 }).catch(() => {});
  const s0 = await state(page);
  await touch('touchStart', [[80, 700, 1]]);
  await touch('touchMove', [[80, 640, 1]]);
  await page.waitForTimeout(500);
  await touch('touchEnd', []);
  await page.waitForTimeout(250);
  s = await state(page);
  const h = await hud(page);
  check('points: the stick flies forward and the readout follows', s0.pos[2] - s.pos[2] > 0.5 && h.shown && hudMatches(h), { s0: s0.pos, pos: s.pos, h: h.n });
  await page.click('#coords', { timeout: 2000 }).catch(() => {});

  await load(page, 'site.xyz');
  s = await state(page);
  const floor = +(s.start[1] - 1.6).toFixed(3);
  check('sloped site with mezzanine and roof: floor = ground', floor >= -0.05 && floor <= 1.5, { floor, start: s.start, size: s.size });

  const upload = async (name, text) => {
    await page.evaluate(() => window.app.bounds.makeEmpty());
    await page.setInputFiles('#file', { name, mimeType: 'application/octet-stream', buffer: Buffer.from(text, 'latin1') });
    await loaded(page, 10000).catch(() => console.log('(not opened:', name, ')'));
    await page.waitForTimeout(300);
  };
  const roomXyz = fs.readFileSync(`${A}/room.xyz`, 'latin1'), n = lines('room.xyz');
  const ghosts = {};
  for (const [name, extra] of [['5 points 4m under', '0,-4,0,9,9,9\n'.repeat(5)], ['1 point 30m under', '1,-30,1,9,9,9\n']]) {
    await upload('ghost.xyz', roomXyz + extra);
    ghosts[name] = (await state(page)).start[1];
  }
  check('xyz: stray points below do not move the start', Object.values(ghosts).every(y => near(y, 1.6, 0.03)), ghosts);
  await upload('cr.xyz', roomXyz.replace(/\n/g, '\r') + '1e999,0,0,9,9,9\r');
  let c = await cloud();
  check('xyz: CR line ends; infinite point dropped', c?.n === n, { n: c?.n, want: n });
  const roomPly = fs.readFileSync(`${A}/room.ply`, 'latin1').split('\n');
  const body = roomPly.findIndex(l => l === 'end_header') + 1;
  for (let i = body; i < body + 3; i++) roomPly[i] = 'nan nan nan 0 0 0 0 0 1 0';
  roomPly[body + 3] = 'inf 0 0 0 0 0 0 0 1 0';
  await upload('nan.ply', roomPly.join('\n'));
  c = await cloud();
  s = await state(page);
  const nanPx = await brightness(page);
  check('ply with NaN/inf: dropped, rest drawn', c?.n === n - 4 && nanPx > 25 && near(s.start[1], 1.6, 0.03), { n: c?.n, want: n - 4, nanPx, start: s.start });

  await objectView(page, 'points', 'object.xyz');
  await load(page, 'object.ply');
  s = await state(page);
  check('object ply: starts outside it, like the xyz', !(await page.evaluate(() => window.app.bounds.containsPoint(window.app.camera.position))), s);

  await load(page, 'room_y.usdz');
  check('a mesh scan after points: 조명 is back', await page.isVisible('#light'), null);

  await load(page, 'room.xyz');
  await page.reload();
  await loaded(page);
  check('xyz: reopened from IndexedDB after a reload', (await cloud())?.n === lines('room.xyz'), null);

  await page.setInputFiles('#file', { name: 'x.xyz', mimeType: 'text/plain', buffer: Buffer.from('no points here\n') });
  await page.waitForSelector('#toast', { state: 'visible' });
  check('an xyz with no points: message only, scan stays', (await page.textContent('#toast')).includes('열 수 없습니다') && (await cloud())?.n > 0, null);

  const unexpected = warnings.filter(w => !w.includes('점이 없습니다') && !w.includes('USDAParser'));
  const errs = errors.filter(e => !e.includes('Computed radius is NaN')); // logged by PLYLoader while parsing nan.ply
  check('points: no console errors or unexpected warnings', errs.length === 0 && unexpected.length === 0, { errors, unexpected });
  await page.context().close();
}

// ---------- privacy and supply chain ----------
{
  const { page, errors } = await newPage({});
  await idle(page);
  const net = await page.evaluate(async () => {
    const blocked = [];
    document.addEventListener('securitypolicyviolation', e => blocked.push(`${e.effectiveDirective} ${e.blockedURI}`));
    const f = await fetch('https://example.com/x').then(() => 'allowed', () => 'blocked');
    navigator.sendBeacon('https://example.com/b', 'x');
    await new Promise(r => setTimeout(r, 500));
    return { fetch: f, blocked };
  });
  check('CSP blocks fetch and beacon', net.fetch === 'blocked' && net.blocked.filter(b => b.startsWith('connect-src')).length === 2, { ...net, consoleErrors: errors.length });
  await page.context().close();

  const t = await newPage({}, p => p.route(LOADER_URL, async route => {
    const res = await route.fetch();
    route.fulfill({ response: res, body: (await res.text()) + '\n// tampered\n' });
  }));
  await t.page.waitForTimeout(3000);
  const started = await t.page.evaluate(() => !!window.app);
  check('SRI: a tampered CDN module stops the app', !started && t.errors.some(e => /integrity/i.test(e)), t.errors.slice(0, 2));
  await t.page.context().close();
}

// ---------- iPhone-size touch ----------
{
  const { page, errors, warnings } = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await idle(page);
  await shot(page, 'm0-intro');
  await page.setInputFiles('#file', { name: 'x.usdz', mimeType: 'application/octet-stream', buffer: Buffer.from('not a usdz') });
  await page.waitForFunction(() => document.getElementById('msg').textContent.length > 0);
  check('bad file with nothing open: message on the intro', await page.evaluate(() => !document.getElementById('intro').hidden && document.getElementById('msg').textContent.includes('열 수 없습니다')), null);
  await load(page, 'room_y.usdz');
  await shot(page, 'm1-loaded');
  let s = await state(page), s0;
  check('touch: room scan starts at eye height over the floor', near(s.start[1], 1.6, 0.01) && `${s.pos}` === `${s.start}`, s);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  const L = [80, 700], R = [300, 700];
  async function push([x, y], dx, dy, ms) {
    await touch('touchStart', [[x, y, 1]]);
    await touch('touchMove', [[x + dx, y + dy, 1]]);
    await page.waitForTimeout(ms);
    await touch('touchEnd', []);
    await page.waitForTimeout(100);
  }
  async function down([x, y], dx, dy, id) {
    await touch('touchStart', [[x, y, id]]);
    await touch('touchMove', [[x + dx, y + dy, id]]);
  }
  const moved = (a, b) => +Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]).toFixed(3);

  const fwd = {};
  for (const [name, y, pitch, ms] of [['level', 2.6, 0, 500], ['up', 2.6, 0.6, 500], ['down', 1, -0.6, 1000]]) {
    await place(page, 0, y, 0.75, 0, pitch);
    s0 = await state(page);
    await push(L, 0, -60, ms);
    s = await state(page);
    fwd[name] = { dy: +(s.pos[1] - s0.pos[1]).toFixed(3), dz: +(s.pos[2] - s0.pos[2]).toFixed(3), y: s.pos[1] };
  }
  check('touch: left stick forward, level: same height', near(fwd.level.dy, 0, 0.02) && fwd.level.dz < -0.5, fwd.level);
  check('touch: left stick forward, looking up: climbs', fwd.up.dy > 0.5 && fwd.up.dz < -0.5, fwd.up);
  check('touch: left stick forward, looking down: through floor', fwd.down.y < -0.3 && fwd.down.dz < -0.5, fwd.down);

  await place(page, 0, 2.6, 0.75, 0, 0.6);
  s0 = await state(page);
  await push(L, 60, 0, 500);
  s = await state(page);
  check('touch: left stick sideways: level strafe', s.pos[0] - s0.pos[0] > 0.5 && near(s.pos[1], s0.pos[1], 0.02) && s.yaw === s0.yaw, { s0: s0.pos, pos: s.pos, yaw: [s0.yaw, s.yaw] });
  s0 = s;
  await page.waitForTimeout(500);
  s = await state(page);
  check('touch: released stick hovers there', `${s.pos}` === `${s0.pos}`, { s0: s0.pos, pos: s.pos });

  await touch('touchStart', [[...L, 1]]);
  await touch('touchMove', [[L[0], L[1] - 28, 1]]);
  await page.waitForTimeout(100);
  const half = await page.evaluate(() => +window.app.input.move.y.toFixed(3));
  await touch('touchEnd', []);
  check('touch: half stick ~1/3 speed (expo)', half > 0.25 && half < 0.4, { half });

  await place(page, 0, 1.9, 0.75);
  await down(R, 60, 0, 3);
  await page.waitForTimeout(250);
  const y1 = (await state(page)).yaw;
  await page.waitForTimeout(500);
  const y2 = (await state(page)).yaw;
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  const y3 = (await state(page)).yaw;
  await page.waitForTimeout(400);
  s = await state(page);
  const rate = +((y1 - y2) / 0.5).toFixed(2);
  check('touch: right stick held: turns ~90°/s, stops on release', near(rate, Math.PI / 2, 0.25) && s.yaw === y3 && `${s.pos}` === '0,1.9,0.75', { rate, y1, y2, y3, after: s.yaw, pos: s.pos });
  await place(page, 0, 1.9, 0.75);
  await down(R, 0, -60, 3);
  await page.waitForTimeout(150);
  const p1 = (await state(page)).pitch;
  await page.waitForTimeout(400);
  const p2 = (await state(page)).pitch;
  await touch('touchEnd', []);
  const pitchRate = +((p2 - p1) / 0.4).toFixed(2);
  check('touch: right stick up looks up ~90°/s', near(pitchRate, Math.PI / 2, 0.25), { pitchRate, p1, p2 });
  await push(R, 0, -60, 2500);
  const up = (await state(page)).pitch;
  await push(R, 0, 60, 4500);
  const downP = (await state(page)).pitch;
  check('touch: pitch stops at ±1.5 rad', up === 1.5 && downP === -1.5, { up, down: downP });
  await place(page, 0, 1.9, 0.75);
  await push([300, 200], 60, 0, 500);
  s = await state(page);
  check('touch: right stick high on screen', s.yaw < -0.5, s.yaw);

  await click(page, '#reset');
  s0 = await state(page);
  s0 = await state(page);
  await touch('touchStart', [[...L, 1]]);
  await touch('touchMove', [[L[0], L[1] - 60, 1]]);
  await touch('touchStart', [[L[0], L[1] - 60, 1], [...R, 2]]);
  await touch('touchMove', [[L[0], L[1] - 60, 1], [R[0] - 60, R[1], 2]]);
  await page.waitForTimeout(800);
  await shot(page, 'm2-both-sticks');
  const sticksOn = await page.evaluate(() => document.querySelectorAll('.stick.on').length);
  await touch('touchEnd', [[L[0], L[1] - 60, 1]]);
  await touch('touchEnd', []);
  s = await state(page);
  check('touch: both sticks at once', moved(s0, s) > 0.5 && s.yaw - s0.yaw > 0.8 && sticksOn === 2, { s0: s0.pos, pos: s.pos, yaw: s.yaw, sticksOn });

  await click(page, '#reset');
  s0 = await state(page);
  await touch('touchStart', [[...L, 1]]);
  await touch('touchMove', [[L[0], L[1] - 60, 1]]);
  await touch('touchStart', [[L[0], L[1] - 60, 1], [150, 400, 2]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[L[0], L[1] - 60, 1], [150 + i * 5, 400 - i * 5, 2]]); await page.waitForTimeout(30); }
  await touch('touchEnd', [[L[0], L[1] - 60, 1]]);
  await touch('touchEnd', []);
  s = await state(page);
  check('touch: a second finger on the move half is ignored', s.yaw === s0.yaw && s.pitch === s0.pitch && moved(s0, s) > 0.3, { s0, s });

  await click(page, '#reset');
  await touch('touchStart', [[...L, 5]]);
  await touch('touchMove', [[L[0], L[1] - 60, 5]]);
  await touch('touchStart', [[L[0], L[1] - 60, 5], [...R, 6]]);
  await touch('touchMove', [[L[0], L[1] - 60, 5], [R[0], R[1] - 60, 6]]);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const a = await state(page);
  await page.waitForTimeout(500);
  const b = await state(page);
  const stickOn = await page.evaluate(() => !!document.querySelector('.stick.on'));
  await touch('touchEnd', []);
  check('touch: blur releases both sticks', a.pos[2] < 0.6 && `${a.pos}` === `${b.pos}` && a.pitch > 0.2 && a.pitch === b.pitch && !stickOn, { a: [a.pos, a.pitch], b: [b.pos, b.pitch], stickOn });

  await click(page, '#reset');
  await place(page, 0, 2.1, 0.75, 0, -0.6);
  await page.waitForTimeout(200);
  s0 = await state(page);
  for (const x of [300, 100]) {
    await page.touchscreen.tap(x, 600);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(x, 600);
    await page.waitForTimeout(400);
  }
  s = await state(page);
  check('touch: double-tap on the floor does not move you', `${s.pos}` === `${s0.pos}`, { before: s0.pos, after: s.pos });

  await click(page, '#reset');
  const h0 = await hud(page);
  check('touch: camera readout hidden by default', !h0.shown && h0.pressed === 'false', h0);
  await page.click('#coords', { timeout: 2000 }).catch(() => {}); // FAIL, not abort, if missing
  await page.waitForTimeout(250);
  const h1 = await hud(page);
  await push(L, 0, -60, 500);
  await push(R, 60, 0, 300);
  await page.waitForTimeout(250);
  const h2 = await hud(page);
  await shot(page, 'm4-coords');
  check('touch: 좌표 shows x y z and pitch yaw roll of the camera', h1.shown && h1.pressed === 'true' && hudMatches(h1), h1);
  check('touch: the readout follows both sticks', h2.shown && hudMatches(h2) && Math.hypot(h2.n[0] - h1.n[0], h2.n[2] - h1.n[2]) > 0.5 && Math.abs(h2.n[4] - h1.n[4]) > 10, { h1: h1.n, h2: h2.n });
  const row = await page.evaluate(() => [...document.querySelectorAll('#bar button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return [b.textContent, Math.round(r.top), Math.round(r.left), Math.round(r.right), +r.height.toFixed(1)]; }));
  check('touch: 390px bar on one row, ~39px tall', row.length === 7 && row.every(b => b[1] === row[0][1] && b[2] >= 0 && b[3] <= 390 && b[4] >= 39), row);
  await page.reload();
  await loaded(page);
  await page.waitForTimeout(250); // ~10Hz readout
  const h3 = await hud(page);
  await page.click('#coords', { timeout: 2000 }).catch(() => {}); // FAIL, not abort, if missing
  const h4 = await hud(page);
  check('touch: readout kept on after reload, 좌표 hides', h3.shown && hudMatches(h3) && !h4.shown && h4.pressed === 'false', { h3, h4 });

  const guides = await page.evaluate(() => [...document.querySelectorAll('.stick')].map(e => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, bottom: r.bottom, w: r.width, label: getComputedStyle(e, '::after').content };
  }));
  const updown = await page.evaluate(() => !!document.getElementById('updown'));
  await shot(page, 'm3-guides');
  check('touch: guides 이동 left, 시점 right', guides.length === 2 && guides[0].x < 195 && guides[1].x > 195 &&
    guides[0].label === '"이동"' && guides[1].label === '"시점"' &&
    guides.every(g => g.w > 0 && g.y > 422 && g.left >= 0 && g.right <= 390 && g.bottom <= 844) && !updown, { guides, updown });
  await objectView(page, 'touch');
  const scroll = await page.evaluate(() => [scrollX, scrollY, document.documentElement.scrollHeight <= innerHeight]);
  check('touch: page did not scroll', scroll[0] === 0 && scroll[1] === 0 && scroll[2], scroll);
  const unexpected = warnings.filter(w => !w.includes('메시가 없습니다') && !w.includes('USDAParser'));
  check('touch: no console errors or unexpected warnings', errors.length === 0 && unexpected.length === 0, { errors, unexpected });
  await page.context().close();
}

// ---------- landscape touch ----------
{
  const { page, errors } = await newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await idle(page);
  await load(page, 'room_y.usdz');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  let s0 = await state(page);
  await touch('touchStart', [[150, 330, 1]]);
  await touch('touchMove', [[150, 270, 1]]);
  await page.waitForTimeout(500);
  await shot(page, 'l1-landscape');
  await touch('touchEnd', []);
  let s = await state(page);
  check('touch landscape: left stick flies forward', s.pos[2] - s0.pos[2] < -0.5, { s0: s0.pos, pos: s.pos });
  s0 = s;
  await touch('touchStart', [[700, 300, 2]]);
  await touch('touchMove', [[640, 300, 2]]);
  await page.waitForTimeout(250);
  const ly1 = (await state(page)).yaw;
  await page.waitForTimeout(500);
  const ly2 = (await state(page)).yaw;
  await touch('touchEnd', []);
  s = await state(page);
  check('touch landscape: right stick turns', ly2 - ly1 > 0.5 && `${s.pos}` === `${s0.pos}` && errors.length === 0, { ly1, ly2, s0: s0.pos, pos: s.pos, errors });
  await page.context().close();
}

await browser.close();
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

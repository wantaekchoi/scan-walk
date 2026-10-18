// End-to-end check in headless Chromium (Playwright). Not part of the app.
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
const BVH_URL = 'https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.16/build/index.module.js';

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
const loaded = page => page.waitForFunction(() => window.app?.player.bvh && document.getElementById('busy').hidden && document.getElementById('intro').hidden, null, { timeout: 30000 });
async function load(page, file) {
  await page.evaluate(() => { if (window.app) window.app.player.bvh = null; });
  await page.setInputFiles('#file', `${A}/${file}`);
  await loaded(page);
  await page.waitForTimeout(300);
}
async function click(page, sel) { await page.click(sel); await idle(page); } // axis/scale rebuild behind the busy overlay
const state = page => page.evaluate(() => {
  const { player, input, bounds, start } = window.app;
  const r = v => +v.toFixed(3);
  return { pos: player.pos.toArray().map(r), yaw: r(input.yaw), pitch: r(input.pitch), fly: player.fly,
    size: bounds.getSize(bounds.min.clone()).toArray().map(r), centre: bounds.getCenter(bounds.min.clone()).toArray().map(r), start: start.toArray().map(r) };
});
// camera readout: the numbers on screen (x y z m, pitch yaw roll deg) next to the camera's own
const hud = page => page.evaluate(() => {
  const e = document.getElementById('hud'), { position: p, rotation: r } = window.app.camera, deg = v => v * 180 / Math.PI;
  return { shown: !!e && !e.hidden && e.getBoundingClientRect().height > 0, n: (e?.textContent.match(/-?\d+(\.\d+)?/g) || []).map(Number),
    cam: [p.x, p.y, p.z, deg(r.x), ((deg(r.y) + 180) % 360 + 360) % 360 - 180, deg(r.z)], pressed: document.getElementById('coords')?.getAttribute('aria-pressed') };
});
const hudMatches = h => h.n.length === 6 && h.n.every((v, i) => near(v, h.cam[i], i < 3 ? 0.006 : 0.06));
const place = (page, x, y, z, yaw = 0, pitch = 0) => page.evaluate(([x, y, z, yaw, pitch]) => {
  const { player, input } = window.app;
  player.pos.set(x, y, z); player.vy = 0; player.grounded = false; input.yaw = yaw; input.pitch = pitch;
}, [x, y, z, yaw, pitch]);
const setMode = async (page, fly) => { if ((await state(page)).fly !== fly) await click(page, '#mode'); };
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
// mean RGB of the canvas (background 0x111111 = 17), read right after the app's render
const brightness = page => page.evaluate(() => new Promise(res => requestAnimationFrame(() => {
  const g = document.createElement('canvas').getContext('2d');
  g.canvas.width = g.canvas.height = 64;
  g.drawImage(document.getElementById('c'), 0, 0, 64, 64);
  const px = g.getImageData(0, 0, 64, 64).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
  res(Math.round(sum / 3 / 4096));
})));
// small object scan (0.6m cube): flying outside it with the whole box on screen, and 처음 comes back to that view
async function objectView(page, tag) {
  await load(page, 'object.usdz');
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
    let fg = 0; // pixels that aren't the 0x111111 background
    for (let i = 0; i < px.length; i += 4) fg += Math.abs(px[i] - 17) + Math.abs(px[i + 1] - 17) + Math.abs(px[i + 2] - 17) > 30;
    res({ inView, outside: !bounds.containsPoint(camera.position), drawn: +(fg / 4096).toFixed(3) });
  })));
  check(`${tag}: small object starts flying outside it, whole box in view and drawn`, s.fly && (await page.textContent('#mode')) === '비행' && v.inView && v.outside && v.drawn > 0.05, { ...v, pos: s.pos, centre: s.centre });
  await shot(page, `${tag}-object`);
  await place(page, 3, 1, 3, 1, -0.5);
  await click(page, '#reset');
  const r = await state(page);
  check(`${tag}: 처음 returns to the same object view`, r.fly && ['pos', 'yaw', 'pitch'].every(k => `${r[k]}` === `${s[k]}`), { start: s, reset: r });
}

// ---------- desktop ----------
{
  const { page, errors, warnings } = await newPage({ viewport: { width: 1280, height: 800 } });
  await idle(page);
  await shot(page, 'd0-intro');
  await load(page, 'room_y.usdz');
  let s = await state(page);
  check('load room_y: start under bbox centre on floor, flying over it', near(s.start[0], 0, 0.01) && near(s.start[1], 0, 0.01) && near(s.start[2], 0.75, 0.01) && s.fly && (await page.textContent('#mode')) === '비행', s);
  check('room_y size 6 x 2.6 x 6.5', near(s.size[0], 6, 0.01) && near(s.size[1], 2.6, 0.01) && near(s.size[2], 6.5, 0.01), s.size);
  await page.waitForSelector('#forget', { state: 'visible' });
  const sv = await saved(page);
  check('IndexedDB keeps the File itself (not its bytes)', sv?.blob && sv.name === 'room_y.usdz' && sv.size === 6178, sv);
  await shot(page, 'd1-loaded-unlit');

  await setMode(page, false); // collision checks walk
  await hold(page, 'KeyW', 3500);
  s = await state(page);
  check('walk forward into -z wall stops at wall (z ~ -2.25)', near(s.pos[2], -2.24, 0.03) && near(s.pos[1], 0, 0.02), s.pos);
  await shot(page, 'd2-at-wall');

  await place(page, 1.8, 0, 0.5);
  await hold(page, 'KeyW', 2500);
  s = await state(page);
  check('1m box blocks without sliding sideways', near(s.pos[2], -0.44, 0.03) && near(s.pos[0], 1.8, 0.02) && near(s.pos[1], 0, 0.02), s.pos);

  await place(page, 0, 0, -1.5, Math.PI / 4);
  await hold(page, 'KeyW', 1200);
  s = await state(page);
  check('walking 45deg into a wall slides along it', s.pos[2] > -2.27 && s.pos[2] < -2.2 && s.pos[0] < -0.8, s.pos);

  await place(page, -2, 0, -1.5, Math.PI / 4 + 0.2);
  await hold(page, 'KeyW', 2000);
  s = await state(page);
  check('pushing into corner stays inside the room', s.pos[0] > -2.8 && s.pos[2] > -2.3, s.pos);

  await place(page, 0, 0, 0.75, Math.PI);
  await hold(page, 'KeyW', 1300);
  s = await state(page);
  check('walks out through the 0.9m door gap', s.pos[2] > 2.8 && near(s.pos[1], 0, 0.02), s.pos);

  await place(page, -0.5, 0, -1.5, Math.PI / 2);
  await hold(page, 'KeyW', 2000);
  s = await state(page);
  check('walk onto 0.18m step climbs it', near(s.pos[1], 0.18, 0.02) && s.pos[0] < -1.6, s.pos);
  await shot(page, 'd3-on-step');

  // fixed-dt drops onto the 2x1.5m floor patch outside the door, 1..15m high, at low frame rates
  const falls = await page.evaluate(() => {
    const p = window.app.player, out = {};
    for (const fps of [30, 20, 16, 10]) {
      const dt = 1 / fps; let through = 0, tried = 0;
      for (let H = 1; H <= 15; H += 0.25) {
        p.fly = false; p.pos.set(0, H, 3.3); p.vy = 0; p.grounded = false; tried++;
        for (let i = 0; i < Math.ceil(4 / dt); i++) p.update(dt, { x: 0, y: 0 }, 0, 0);
        if (p.pos.y < -0.1) through++;
      }
      out[fps] = `${through}/${tried}`;
    }
    p.pos.set(0, 0, 0.75); p.grounded = false;
    return out;
  });
  check('falling 1-15m at 30/20/16/10 fps never passes through the floor', Object.values(falls).every(v => v.startsWith('0/')), falls);

  // fixed-dt: flying forward goes where the camera looks, pitch included; walking forward stays level
  const pitched = await page.evaluate(() => {
    const p = window.app.player, r = v => +v.toFixed(4), out = {};
    for (const [name, fly, y, pitch, n] of [['up', true, 1, 0.6, 60], ['down', true, 1, -0.6, 60], ['walk', false, 0, -0.6, 30]]) {
      p.fly = fly; p.pos.set(0, y, 0.75); p.vy = 0; p.grounded = false;
      for (let i = 0; i < n; i++) p.update(1 / 60, { x: 0, y: 1 }, 0, 0, pitch);
      out[name] = { dy: r(p.pos.y - y), dz: r(p.pos.z - 0.75) };
    }
    p.fly = false; p.pos.set(0, 0, 0.75); p.grounded = false;
    return out;
  });
  check('fly: forward follows the view pitch, up and down', near(pitched.up.dy, 3 * Math.sin(0.6), 0.01) && near(pitched.down.dy, -3 * Math.sin(0.6), 0.01) &&
    [pitched.up, pitched.down].every(m => near(m.dz, -3 * Math.cos(0.6), 0.01)), pitched);
  check('walk: forward ignores the view pitch', near(pitched.walk.dy, 0, 0.02) && pitched.walk.dz < -0.5, pitched.walk);

  // fixed-dt: it's a viewer, flying passes through everything: level into the step, down through the ceiling and the floor
  const descents = await page.evaluate(() => {
    const p = window.app.player, r = v => +v.toFixed(3), out = {};
    for (const [name, x, y, z, yaw, fwd, up, n] of [['stepLevel', -0.5, 0, -1.5, Math.PI / 2, 1, 0, 30], ['ceiling', 0, 2.9, 0.75, 0, 0, -1, 120]]) {
      p.fly = true; p.pos.set(x, y, z); p.vy = 0;
      for (let i = 0; i < n; i++) p.update(1 / 60, { x: 0, y: fwd }, up, yaw);
      out[name] = p.pos.toArray().map(r);
    }
    p.fly = false; p.pos.set(0, 0, 0.75); p.grounded = false;
    return out;
  });
  check('fly level into the 0.18m step: passes through it, not up onto it', near(descents.stepLevel[1], 0, 0.01) && near(descents.stepLevel[0], -2, 0.01), descents.stepLevel);
  check('fly down from above the ceiling: passes the ceiling and the floor, still descending', near(descents.ceiling[1], -1.1, 0.01), descents.ceiling);

  await place(page, 0, 0, 3.3);
  await page.waitForTimeout(300);
  await place(page, 5, 0, 3.3);
  await page.waitForTimeout(2500);
  s = await state(page);
  check('walking off into the void returns to the last floor stood on', near(s.pos[0], 0, 0.01) && near(s.pos[1], 0, 0.02) && near(s.pos[2], 3.3, 0.01), s.pos);
  await setMode(page, true);
  await place(page, 0, -12, 0.75);
  await page.waitForTimeout(300);
  s = await state(page);
  check('flying 12m under the scan stays there, no snap back', s.fly && near(s.pos[1], -12, 0.01), s.pos);
  // flying passes through floors, so switching to walking with the feet under one must stand on it, not wedge in it
  const landed = {};
  for (const y of [-0.02, -0.7, -1]) {
    await setMode(page, true);
    await place(page, 0, y, 0.75);
    await setMode(page, false);
    await page.waitForTimeout(500);
    landed[y] = await page.evaluate(() => { const p = window.app.player; return [+p.pos.y.toFixed(3), p.grounded, +p.vy.toFixed(2)]; });
  }
  check('walk from flying with the feet 2cm, 0.7m, 1m under the floor: stands on it', Object.values(landed).every(([y, g, vy]) => near(y, 0, 0.02) && g && vy === 0), landed);

  await click(page, '#reset');
  await setMode(page, false);
  let y1 = (await state(page)).pos[1];
  await hold(page, 'Space', 600);
  s = await state(page);
  check('walk: Space takes off into fly mode and rises', s.fly && (await page.textContent('#mode')) === '비행' && s.pos[1] > y1 + 0.5, { y1, y: s.pos[1], fly: s.fly });
  await setMode(page, false);
  await place(page, 0, 0, 0.75); // back on the floor: 1.8m up the head is through the 2.6m ceiling and stuck there
  await page.waitForFunction(() => window.app.player.grounded, null, { timeout: 5000 }).catch(() => {});
  y1 = (await state(page)).pos[1];
  await hold(page, 'ShiftLeft', 600);
  s = await state(page);
  check('walk: Shift does nothing (no descent while walking)', !s.fly && near(s.pos[1], y1, 0.02), { y1, y: s.pos[1], fly: s.fly });

  await click(page, '#reset');
  await setMode(page, true);
  await hold(page, 'KeyW', 2500);
  s = await state(page);
  check('fly mode passes through -z wall', s.fly && s.pos[2] < -2.6, s.pos);
  const y0 = s.pos[1];
  await hold(page, 'Space', 600);
  s = await state(page);
  check('fly: Space rises and does not re-trigger the clicked button', s.fly && s.pos[1] > y0 + 0.5, { y0, y: s.pos[1], fly: s.fly });
  await shot(page, 'd4-fly-outside');
  await place(page, 0, 1, 0.75, 0, 0.6);
  await hold(page, 'KeyW', 1000);
  s = await state(page);
  check('fly: W with the view tilted up climbs along the view', s.fly && s.pos[1] > 1.8 && s.pos[2] < -1, s.pos);
  await click(page, '#reset');
  s = await state(page);
  check('room scan: 처음 returns flying', s.fly && (await page.textContent('#mode')) === '비행', s);
  const hudOff = await hud(page);
  await hold(page, 'KeyC', 50);
  const hudOn = await hud(page);
  await hold(page, 'KeyC', 50);
  check('desktop: C toggles the camera readout, hidden at first', !hudOff.shown && hudOn.shown && hudMatches(hudOn) && !(await hud(page)).shown, { hudOff, hudOn });

  // no teleport: double-clicking the floor leaves you where you are
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
  check('room_z (upAxis Z) upright by loader; starts flying over its floor', near(s.size[1], 2.6, 0.01) && near(s.start[1], 0, 0.01) && s.fly, s);

  await load(page, 'room_z_mislabeled.usdz');
  s = await state(page);
  check('mislabeled Z-up lies on its side (y extent 6.5)', near(s.size[1], 6.5, 0.01), s.size);
  await shot(page, 'd6-mislabeled');
  await click(page, '#axis');
  s = await state(page);
  const axisLabel = await page.textContent('#axis');
  check('axis button -> +Z fixes it (y extent 2.6, start on floor)', near(s.size[1], 2.6, 0.01) && near(s.start[1], 0, 0.01) && axisLabel.includes('+Z'), { s, axisLabel });
  await setMode(page, false);
  await hold(page, 'KeyW', 3500);
  s = await state(page);
  check('after axis fix, wall collision works', near(s.pos[2], -2.24, 0.03), s.pos);
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
  check('nowhere to stand (walls and ceiling only): starts flying with the eye at the centre', s.fly && (await page.textContent('#mode')) === '비행' && near(s.pos[1] + 1.6, s.centre[1], 0.01), s);

  // floor only: no room for the eye under the top of the scan anywhere, still the floor to stand on
  await load(page, 'room_flat.usdz');
  s = await state(page);
  check('floor only, lower than eye height: starts flying over it at its height', s.fly && near(s.start[1], 0, 0.02) && near(s.pos[1], 0, 0.02), s);
  // 3D Scanner App export: room turned off the axes, a hole under the bounding box centre, texture on emissiveColor
  await load(page, 'room_scanner.usdz');
  s = await state(page);
  const off = +Math.hypot(s.start[0] - s.centre[0], s.start[2] - s.centre[2]).toFixed(3);
  check('scanner export: no floor under the centre, starts flying over the nearest floor', s.fly && (await page.textContent('#mode')) === '비행' && near(s.start[1], 0, 0.02) && off < 1, { ...s, off });
  // real scans have holes in the floor: flying down over one keeps going below the scan's bottom
  const holeDown = await page.evaluate(() => {
    const { player: p, bounds: b, start } = window.app, c = b.getCenter(b.min.clone());
    p.pos.set(c.x, 0.5, c.z);
    for (let i = 0; i < 150; i++) p.update(1 / 60, { x: 0, y: 0 }, -1, 0);
    const out = { y: +p.pos.y.toFixed(3), bottom: +b.min.y.toFixed(3) };
    p.pos.copy(start);
    return out;
  });
  check('scanner export: flying down over the hole passes below the bottom of the scan', near(holeDown.y, -4.5, 0.01) && holeDown.y < holeDown.bottom - 4, holeDown);
  const unlit = await brightness(page);
  await shot(page, 'd6b-scanner-unlit');
  await click(page, '#light');
  const lit = await brightness(page);
  await click(page, '#light');
  check('scanner export: emissive texture with black diffuse is drawn, unlit and lit', unlit > 60 && lit > 60, { unlit, lit, background: 17 });

  await load(page, 'room_8k.usdz');
  await page.waitForTimeout(500);
  const resized = warnings.filter(w => w.includes('Texture has been resized from (8192x8192) to (4096x4096)'));
  check('8192px texture is uploaded at 4096', resized.length === 1, resized);

  const cleared = page => page.waitForFunction(() => localStorage.getItem('scan-walk-opening') === null, null, { timeout: 20000 }).then(() => true, () => false);
  await page.reload();
  await loaded(page);
  s = await state(page);
  check('reload reopens the last file from IndexedDB and clears the reopen marker after drawing', near(s.size[0], 6, 0.01) && await cleared(page), s.size);

  // a reopen that never finished (tab killed) must not be retried blindly
  await page.evaluate(() => localStorage.setItem('scan-walk-opening', '1'));
  await page.reload();
  await idle(page);
  await page.waitForTimeout(1000);
  const prompt = await page.evaluate(() => ({ again: !document.getElementById('again').hidden, msg: document.getElementById('msg').textContent, model: !!window.app.player.bvh }));
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
  check('picking another file at the prompt clears the marker and saves it', (await marker(page)) === null && (await saved(page))?.name === 'room_z.usdz', await saved(page));

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
  check('nothing saved: start-up shows the intro', await page.evaluate(() => !document.getElementById('intro').hidden && !window.app.player.bvh), null);

  await load(page, 'room_y.usdz');
  await page.waitForSelector('#forget', { state: 'visible' });
  await page.click('#forget');
  await page.waitForTimeout(300);
  check('"잊기" bar button deletes the saved scan and hides', (await saved(page)) === null && await page.isHidden('#forget'), null);

  await page.setInputFiles('#file', { name: 'x.usdz', mimeType: 'application/octet-stream', buffer: Buffer.from('not a usdz') });
  await page.waitForSelector('#toast', { state: 'visible' });
  const t = await page.evaluate(() => ({ toast: document.getElementById('toast').textContent, intro: !document.getElementById('intro').hidden, model: !!window.app.player.bvh }));
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
  check('CSP: page cannot send data out (fetch and beacon blocked by connect-src)', net.fetch === 'blocked' && net.blocked.filter(b => b.startsWith('connect-src')).length === 2, { ...net, consoleErrors: errors.length });
  await page.context().close();

  const t = await newPage({}, p => p.route(BVH_URL, async route => {
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
  check('touch: room scan loads flying', s.fly && (await page.textContent('#mode')) === '비행', s);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  // one hand moves, the other looks: the left half is a move stick where the thumb lands, the right half drags the view
  const L = [80, 700], R = [300, 700];
  async function push([x, y], dx, dy, ms) {
    await touch('touchStart', [[x, y, 1]]);
    await touch('touchMove', [[x + dx, y + dy, 1]]);
    await page.waitForTimeout(ms);
    await touch('touchEnd', []);
    await page.waitForTimeout(100);
  }
  async function drag([x, y], id) { // right half: 50px left, 30px down
    await touch('touchStart', [[x, y, id]]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [[x - i * 5, y + i * 3, id]]); await page.waitForTimeout(20); }
    await touch('touchEnd', []);
  }
  const moved = (a, b) => +Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]).toFixed(3);

  // flying forward goes where the camera looks: level holds the height, up climbs, down sinks through the floor
  const fwd = {};
  for (const [name, y, pitch, ms] of [['level', 1, 0, 500], ['up', 1, 0.6, 500], ['down', 0.5, -0.6, 1000]]) {
    await place(page, 0, y, 0.75, 0, pitch);
    s0 = await state(page);
    await push(L, 0, -60, ms);
    s = await state(page);
    fwd[name] = { fly: s.fly, dy: +(s.pos[1] - s0.pos[1]).toFixed(3), dz: +(s.pos[2] - s0.pos[2]).toFixed(3), y: s.pos[1] };
  }
  check('touch: left stick forward, looking level, flies forward at that height', fwd.level.fly && near(fwd.level.dy, 0, 0.02) && fwd.level.dz < -0.5, fwd.level);
  check('touch: left stick forward, looking up, climbs as it goes', fwd.up.fly && fwd.up.dy > 0.5 && fwd.up.dz < -0.5, fwd.up);
  check('touch: left stick forward, looking down, sinks through the floor, still flying', fwd.down.fly && fwd.down.y < -0.5 && fwd.down.dz < -0.5, fwd.down);

  await place(page, 0, 1, 0.75, 0, 0.6);
  s0 = await state(page);
  await push(L, 60, 0, 500);
  s = await state(page);
  check('touch: left stick sideways strafes level without turning, even looking up', s.pos[0] - s0.pos[0] > 0.5 && near(s.pos[1], s0.pos[1], 0.02) && s.yaw === s0.yaw, { s0: s0.pos, pos: s.pos, yaw: [s0.yaw, s.yaw] });
  s0 = s;
  await page.waitForTimeout(500);
  s = await state(page);
  check('touch: released stick hovers there', `${s.pos}` === `${s0.pos}`, { s0: s0.pos, pos: s.pos });

  await touch('touchStart', [[...L, 1]]);
  await touch('touchMove', [[L[0], L[1] - 28, 1]]);
  await page.waitForTimeout(100);
  const half = await page.evaluate(() => +window.app.input.move.y.toFixed(3));
  await touch('touchEnd', []);
  check('touch: half stick gives about a third of full speed (expo)', half > 0.25 && half < 0.4, { half });

  await place(page, 0, 0.3, 0.75);
  s0 = await state(page);
  await drag(R, 3);
  s = await state(page);
  check('touch: right half drag turns and tilts the view without moving', near(s.yaw - s0.yaw, 0.3, 0.05) && near(s.pitch - s0.pitch, -0.18, 0.05) && `${s.pos}` === `${s0.pos}`, { s0, s });
  await place(page, 0, 0.3, 0.75);
  s0 = await state(page);
  await drag([300, 200], 3);
  s = await state(page);
  check('touch: right half drag looks from high up the screen too', near(s.yaw - s0.yaw, 0.3, 0.05) && `${s.pos}` === `${s0.pos}`, { s0, s });

  await click(page, '#reset');
  s0 = await state(page);
  await touch('touchStart', [[...L, 1]]);
  await touch('touchMove', [[L[0], L[1] - 60, 1]]);
  await touch('touchStart', [[L[0], L[1] - 60, 1], [...R, 2]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[L[0], L[1] - 60, 1], [R[0] - i * 5, R[1], 2]]); await page.waitForTimeout(30); }
  await page.waitForTimeout(700);
  await shot(page, 'm2-stick-and-look');
  await touch('touchEnd', [[L[0], L[1] - 60, 1]]);
  await touch('touchEnd', []);
  s = await state(page);
  check('touch: left stick flies while the right thumb turns the view', moved(s0, s) > 0.5 && near(s.yaw - s0.yaw, 0.3, 0.05), { s0: s0.pos, pos: s.pos, yaw: s.yaw });

  // thumbs still down when the app loses focus: movement must stop
  await click(page, '#reset');
  await touch('touchStart', [[...L, 5]]);
  await touch('touchMove', [[L[0], L[1] - 60, 5]]);
  await touch('touchStart', [[L[0], L[1] - 60, 5], [...R, 6]]);
  await touch('touchMove', [[L[0], L[1] - 60, 5], [R[0], R[1] - 60, 6]]);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const a = (await state(page)).pos;
  await page.waitForTimeout(500);
  const b = (await state(page)).pos;
  const stickOn = await page.evaluate(() => !!document.querySelector('.stick.on'));
  await touch('touchEnd', []);
  check('touch: blur releases the stick', a[2] < 0.6 && `${a}` === `${b}` && !stickOn, { a, b, stickOn });

  // no teleport: double-tapping the floor, on the look side or the move side, leaves you where you are
  await click(page, '#reset');
  await place(page, 0, 0.5, 0.75, 0, -0.6);
  await page.waitForTimeout(200);
  s0 = await state(page);
  for (const x of [300, 100]) {
    await page.touchscreen.tap(x, 600);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(x, 600);
    await page.waitForTimeout(400);
  }
  s = await state(page);
  check('touch: double-tap on the floor does not move you', `${s.pos}` === `${s0.pos}` && s.fly, { before: s0.pos, after: s.pos });

  // walking: the same stick walks level, looking up included, and never takes off (that's the mode button)
  await setMode(page, false);
  await place(page, 0, 0, 0.75, 0, 0.6);
  await page.waitForFunction(() => window.app.player.grounded, null, { timeout: 5000 }).catch(() => {});
  s0 = await state(page);
  await push(L, 0, -60, 600);
  s = await state(page);
  check('touch: walking, stick forward looking up walks level, no take-off', !s.fly && (await page.textContent('#mode')) === '걷기' && near(s.pos[1], s0.pos[1], 0.02) && s.pos[2] - s0.pos[2] < -0.5, { s0: s0.pos, pos: s.pos, fly: s.fly });

  // camera readout: hidden by default, 좌표 shows it, it follows the stick and the view drag, and a reload keeps it on
  await click(page, '#reset');
  const h0 = await hud(page);
  check('touch: camera readout hidden by default', !h0.shown && h0.pressed === 'false', h0);
  await page.click('#coords', { timeout: 2000 }).catch(() => {}); // a FAIL, not a crash, where it's missing
  await page.waitForTimeout(250);
  const h1 = await hud(page);
  await push(L, 0, -60, 500);
  await drag(R, 3);
  await page.waitForTimeout(250);
  const h2 = await hud(page);
  await shot(page, 'm4-coords');
  check('touch: 좌표 shows x y z and pitch yaw roll of the camera', h1.shown && h1.pressed === 'true' && hudMatches(h1), h1);
  check('touch: the readout follows the stick and the view drag', h2.shown && hudMatches(h2) && Math.hypot(h2.n[0] - h1.n[0], h2.n[2] - h1.n[2]) > 0.5 && Math.abs(h2.n[4] - h1.n[4]) > 10, { h1: h1.n, h2: h2.n });
  const row = await page.evaluate(() => [...document.querySelectorAll('#bar button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return [b.textContent, Math.round(r.top), Math.round(r.left), Math.round(r.right)]; }));
  check('touch: 390px bar keeps every button on one row, 좌표 and 잊기 included', row.length === 8 && row.every(b => b[1] === row[0][1] && b[2] >= 0 && b[3] <= 390), row);
  await page.reload();
  await loaded(page);
  await page.waitForTimeout(250); // ~10Hz readout
  const h3 = await hud(page);
  await page.click('#coords', { timeout: 2000 }).catch(() => {}); // a FAIL, not a crash, where it's missing
  const h4 = await hud(page);
  check('touch: readout stays on after a reload, 좌표 again hides it', h3.shown && hudMatches(h3) && !h4.shown && h4.pressed === 'false', { h3, h4 });

  // resting guides, one per thumb, low on the screen: 이동 left, 시점 right; the old ▲▼ buttons are gone
  const guides = await page.evaluate(() => [...document.querySelectorAll('.stick')].map(e => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, bottom: r.bottom, w: r.width, label: getComputedStyle(e, '::after').content };
  }));
  const updown = await page.evaluate(() => !!document.getElementById('updown'));
  await shot(page, 'm3-guides');
  check('touch: guides at the bottom, 이동 left and 시점 right; ▲▼ gone', guides.length === 2 && guides[0].x < 195 && guides[1].x > 195 &&
    guides[0].label === '"이동"' && guides[1].label === '"시점"' &&
    guides.every(g => g.w > 0 && g.y > 422 && g.left >= 0 && g.right <= 390 && g.bottom <= 844) && !updown, { guides, updown });
  await objectView(page, 'touch');
  const scroll = await page.evaluate(() => [scrollX, scrollY, document.documentElement.scrollHeight <= innerHeight]);
  check('touch: page did not scroll', scroll[0] === 0 && scroll[1] === 0 && scroll[2], scroll);
  const unexpected = warnings.filter(w => !w.includes('메시가 없습니다') && !w.includes('USDAParser'));
  check('touch: no console errors or unexpected warnings', errors.length === 0 && unexpected.length === 0, { errors, unexpected });
  await page.context().close();
}

// ---------- landscape touch: same rule, left half moves, right half looks ----------
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
  await touch('touchStart', [[700, 200, 2]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[700 - i * 5, 200 + i * 3, 2]]); await page.waitForTimeout(20); }
  await touch('touchEnd', []);
  s = await state(page);
  check('touch landscape: right half drag turns and tilts the view', near(s.yaw - s0.yaw, 0.3, 0.05) && near(s.pitch - s0.pitch, -0.18, 0.05) && `${s.pos}` === `${s0.pos}` && errors.length === 0, { s0, s, errors });
  await page.context().close();
}

await browser.close();
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

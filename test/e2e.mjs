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
const place = (page, x, y, z, yaw = 0, pitch = 0) => page.evaluate(([x, y, z, yaw, pitch]) => {
  const { player, input } = window.app;
  player.pos.set(x, y, z); player.vy = 0; player.grounded = false; input.yaw = yaw; input.pitch = pitch;
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

// ---------- desktop ----------
{
  const { page, errors, warnings } = await newPage({ viewport: { width: 1280, height: 800 } });
  await idle(page);
  await shot(page, 'd0-intro');
  await load(page, 'room_y.usdz');
  let s = await state(page);
  check('load room_y: start under bbox centre on floor, walking', near(s.start[0], 0, 0.01) && near(s.start[1], 0, 0.01) && near(s.start[2], 0.75, 0.01) && !s.fly, s);
  check('room_y size 6 x 2.6 x 6.5', near(s.size[0], 6, 0.01) && near(s.size[1], 2.6, 0.01) && near(s.size[2], 6.5, 0.01), s.size);
  await page.waitForSelector('#forget', { state: 'visible' });
  const sv = await saved(page);
  check('IndexedDB keeps the File itself (not its bytes)', sv?.blob && sv.name === 'room_y.usdz' && sv.size === 6178, sv);
  await shot(page, 'd1-loaded-unlit');

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

  await place(page, 0, 0, 3.3);
  await page.waitForTimeout(300);
  await place(page, 5, 0, 3.3);
  await page.waitForTimeout(2500);
  s = await state(page);
  check('walking off into the void returns to the last floor stood on', near(s.pos[0], 0, 0.01) && near(s.pos[1], 0, 0.02) && near(s.pos[2], 3.3, 0.01), s.pos);

  await click(page, '#reset');
  await click(page, '#mode');
  await hold(page, 'KeyW', 2500);
  s = await state(page);
  check('fly mode passes through -z wall', s.fly && s.pos[2] < -2.6, s.pos);
  const y0 = s.pos[1];
  await hold(page, 'Space', 600);
  s = await state(page);
  check('fly: Space rises and does not re-trigger the clicked button', s.fly && s.pos[1] > y0 + 0.5, { y0, y: s.pos[1], fly: s.fly });
  await shot(page, 'd4-fly-outside');
  await click(page, '#mode');
  await click(page, '#reset');

  await place(page, 0, 0, 0.75, 0, -0.5);
  await page.waitForTimeout(200);
  let before = (await state(page)).pos;
  await page.mouse.dblclick(500, 620);
  await page.waitForTimeout(300);
  s = await state(page);
  check('double-click floor teleports onto floor', near(s.pos[1], 0, 0.02) && Math.hypot(s.pos[0] - before[0], s.pos[2] - before[2]) > 0.3 && s.pos[2] < before[2], { before, after: s.pos });
  await page.evaluate(() => document.exitPointerLock?.());
  await place(page, 0, 0, 0.75, 0, 0.2);
  await page.waitForTimeout(200);
  await page.mouse.dblclick(640, 300);
  await page.waitForTimeout(300);
  s = await state(page);
  await page.evaluate(() => document.exitPointerLock?.());
  check('double-click on wall does not teleport', near(s.pos[2], 0.75, 0.02), s.pos);

  await click(page, '#light');
  await click(page, '#reset');
  await page.waitForTimeout(300);
  await shot(page, 'd5-lit');
  await click(page, '#light');

  await load(page, 'room_z.usdz');
  s = await state(page);
  check('room_z (upAxis Z) upright by loader; back in walk mode', near(s.size[1], 2.6, 0.01) && near(s.start[1], 0, 0.01) && !s.fly, s);

  await load(page, 'room_z_mislabeled.usdz');
  s = await state(page);
  check('mislabeled Z-up lies on its side (y extent 6.5)', near(s.size[1], 6.5, 0.01), s.size);
  await shot(page, 'd6-mislabeled');
  await click(page, '#axis');
  s = await state(page);
  const axisLabel = await page.textContent('#axis');
  check('axis button -> +Z fixes it (y extent 2.6, start on floor)', near(s.size[1], 2.6, 0.01) && near(s.start[1], 0, 0.01) && axisLabel.includes('+Z'), { s, axisLabel });
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
  check('no floor under the centre: starts flying with the eye at the centre', s.fly && (await page.textContent('#mode')) === '비행' && near(s.pos[1] + 1.6, s.centre[1], 0.01), s);

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
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });

  let s0 = await state(page);
  await touch('touchStart', [[80, 700, 1]]);
  await touch('touchMove', [[80, 640, 1]]);
  await touch('touchStart', [[80, 640, 1], [300, 400, 2]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[80, 640, 1], [300 - i * 5, 400, 2]]); await page.waitForTimeout(30); }
  await page.waitForTimeout(700);
  await shot(page, 'm2-joystick-and-look');
  await touch('touchEnd', [[80, 640, 1]]);
  await touch('touchEnd', []);
  let s = await state(page);
  check('touch: joystick moves while second finger turns view', Math.hypot(s.pos[0] - s0.pos[0], s.pos[2] - s0.pos[2]) > 0.5 && near(s.yaw - s0.yaw, 0.3, 0.05), { s0: s0.pos, pos: s.pos, yaw: s.yaw });

  // thumb still on the stick when the app loses focus: movement must stop
  await click(page, '#reset');
  await touch('touchStart', [[80, 700, 5]]);
  await touch('touchMove', [[80, 640, 5]]);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const a = (await state(page)).pos;
  await page.waitForTimeout(500);
  const b = (await state(page)).pos;
  const stickOn = await page.evaluate(() => document.getElementById('stick').classList.contains('on'));
  await touch('touchEnd', []);
  check('touch: blur releases the joystick', a[2] < 0.6 && near(a[2], b[2], 0.001) && !stickOn, { a, b, stickOn });

  await click(page, '#reset');
  await place(page, 0, 0, 0.75, 0, -0.6);
  await page.waitForTimeout(200);
  s0 = await state(page);
  await page.evaluate(() => {
    const p = window.app.player.pos, copy = p.copy.bind(p);
    window.__moves = 0; window.__dbl = 0;
    p.copy = v => { window.__moves++; return copy(v); };
    document.getElementById('c').addEventListener('dblclick', () => window.__dbl++);
  });
  await page.touchscreen.tap(220, 600);
  await page.waitForTimeout(120);
  await page.touchscreen.tap(220, 600);
  await page.waitForTimeout(500);
  s = await state(page);
  const counts = await page.evaluate(() => ({ teleports: window.__moves, dblclickEvents: window.__dbl }));
  check('touch: double-tap floor teleports exactly once', near(s.pos[1], 0, 0.02) && s.pos[2] < s0.pos[2] - 0.3 && counts.teleports === 1, { before: s0.pos, after: s.pos, ...counts });

  await page.tap('#mode');
  await page.waitForTimeout(200);
  const y0 = (await state(page)).pos[1];
  const box = await page.locator('#up').boundingBox();
  await touch('touchStart', [[box.x + box.width / 2, box.y + box.height / 2, 4]]);
  await page.waitForTimeout(600);
  await shot(page, 'm3-fly-buttons');
  await touch('touchEnd', []);
  s = await state(page);
  check('touch: fly up button rises', s.fly && s.pos[1] > y0 + 0.5, { y0, y: s.pos[1] });
  const scroll = await page.evaluate(() => [scrollX, scrollY, document.documentElement.scrollHeight <= innerHeight]);
  check('touch: page did not scroll', scroll[0] === 0 && scroll[1] === 0 && scroll[2], scroll);
  const unexpected = warnings.filter(w => !w.includes('메시가 없습니다') && !w.includes('USDAParser'));
  check('touch: no console errors or unexpected warnings', errors.length === 0 && unexpected.length === 0, { errors, unexpected });
  await page.context().close();
}

await browser.close();
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

// Keyboard, mouse (pointer lock or drag), double-tap, and touch: one hand moves, the other looks.
// The left half is a move stick where the thumb lands (forward/back, sideways); the right half drags the view.
// DEAD/EXPO: per-axis dead zone and expo curve, after DJI's defaults (expo 0.25)
const STICK_R = 56, TAP_MS = 300, TAP_PX = 10, DEAD = 0.15, EXPO = 0.25;
const shape = v => { // dead zone, then expo: fine control near the centre, full speed at the edge
  const a = Math.max(0, (Math.abs(v) - DEAD) / (1 - DEAD));
  return Math.sign(v) * ((1 - EXPO) * a + EXPO * a ** 3);
};

export function setupInput(canvas, stickEl, onTeleport) {
  const s = { yaw: 0, pitch: 0, move: { x: 0, y: 0 }, up: 0 };
  const keys = new Set();
  const ptrs = new Map(); // pointerId -> { x, y, x0, y0, t0, stick }
  let lastTap = null, lockedAt = 0, lastType = '';
  const stick = { el: stickEl, x: 0, y: 0 };

  const look = (dx, dy, k) => {
    s.yaw -= dx * k;
    s.pitch = Math.max(-1.5, Math.min(1.5, s.pitch - dy * k));
  };
  const showStick = ({ el }, x, y, kx = 0, ky = 0) => {
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.firstElementChild.style.transform = `translate(${kx}px, ${ky}px)`;
  };
  const hideStick = () => { // the thumb is off: back to the centre, so you stop there
    stick.x = stick.y = 0;
    stick.el.classList.remove('on');
    stick.el.style.transform = stick.el.firstElementChild.style.transform = '';
  };

  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch {} // throws while pointer-locked
    lastType = e.pointerType;
    // left half: the move stick, where the thumb lands; the right half, or a second finger on the left, looks
    const on = e.pointerType !== 'mouse' && e.clientX < innerWidth / 2 && ![...ptrs.values()].some(p => p.stick);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), stick: on });
    if (on) {
      stick.el.classList.add('on');
      showStick(stick, e.clientX, e.clientY);
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (document.pointerLockElement === canvas) return look(e.movementX, e.movementY, 0.0025);
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (p.stick) {
      let dx = e.clientX - p.x0, dy = e.clientY - p.y0;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) { dx *= STICK_R / len; dy *= STICK_R / len; }
      stick.x = dx / STICK_R;
      stick.y = -dy / STICK_R;
      showStick(stick, p.x0, p.y0, dx, dy);
    } else {
      look(e.clientX - p.x, e.clientY - p.y, e.pointerType === 'mouse' ? 0.004 : 0.006);
    }
    p.x = e.clientX;
    p.y = e.clientY;
  });

  const end = e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    if (p.stick) hideStick();
    const tap = e.type === 'pointerup' && performance.now() - p.t0 < TAP_MS &&
      Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < TAP_PX;
    if (!tap) return;
    if (e.pointerType === 'mouse') {
      // click locks the pointer; the browser may refuse (iOS, iframes) and drag-look still works
      if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        try { canvas.requestPointerLock()?.catch?.(() => {}); } catch {}
      }
      return;
    }
    const now = performance.now();
    if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      lastTap = null;
      onTeleport(e.clientX, e.clientY);
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  document.addEventListener('pointerlockchange', () => {
    lockedAt = document.pointerLockElement === canvas ? performance.now() : 0;
  });
  canvas.addEventListener('dblclick', e => {
    if (lastType !== 'mouse') return; // touch double-taps are handled above; browsers also send dblclick for them
    // locked for a while: aim with the crosshair; just locked by this double-click: where it was clicked
    const center = lockedAt && performance.now() - lockedAt > 600;
    onTeleport(center ? innerWidth / 2 : e.clientX, center ? innerHeight / 2 : e.clientY);
  });

  addEventListener('keydown', e => { if (!e.repeat) keys.add(e.code); });
  addEventListener('keyup', e => keys.delete(e.code));
  // app switch / notification: drop held keys and fingers so nothing keeps moving
  const reset = () => {
    keys.clear();
    ptrs.clear();
    lastTap = null;
    hideStick();
  };
  addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => document.hidden && reset());

  // call once per frame: merges the stick and keys into s.move and s.up
  s.poll = () => {
    const k = c => (keys.has(c) ? 1 : 0);
    let x = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
    let y = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    s.move.x = len ? x : shape(stick.x);
    s.move.y = len ? y : shape(stick.y);
    s.up = k('Space') + k('KeyE') - k('ShiftLeft') - k('ShiftRight') - k('KeyQ');
  };
  return s;
}

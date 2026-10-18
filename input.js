const STICK_R = 56, TAP_MS = 300, TAP_PX = 10; // px, ms, px
const DEAD = 0.15, EXPO = 0.25, TURN = Math.PI / 2; // stick fraction, cubic share, rad/s at full tilt
const shape = v => { // per axis: dead zone, then expo
  const a = Math.max(0, (Math.abs(v) - DEAD) / (1 - DEAD));
  return Math.sign(v) * ((1 - EXPO) * a + EXPO * a ** 3);
};

export function setupInput(canvas, stickEls) {
  const s = { yaw: 0, pitch: 0, move: { x: 0, y: 0 }, up: 0 };
  const keys = new Set();
  const ptrs = new Map(); // pointerId -> { x, y, x0, y0, t0, stick }
  const [move, turn] = stickEls.map(el => ({ el, x: 0, y: 0 }));

  const look = (dx, dy, k) => {
    s.yaw -= dx * k;
    s.pitch = Math.max(-1.5, Math.min(1.5, s.pitch - dy * k));
  };
  const showStick = ({ el }, x, y, kx = 0, ky = 0) => {
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.firstElementChild.style.transform = `translate(${kx}px, ${ky}px)`;
  };
  const hideStick = st => {
    st.x = st.y = 0;
    st.el.classList.remove('on');
    st.el.style.transform = st.el.firstElementChild.style.transform = '';
  };

  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch {} // throws while pointer-locked
    const stick = e.pointerType !== 'mouse' && (e.clientX < innerWidth / 2 ? move : turn);
    if (stick && [...ptrs.values()].some(p => p.stick === stick)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), stick });
    if (stick) {
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
      p.stick.x = dx / STICK_R;
      p.stick.y = -dy / STICK_R;
      showStick(p.stick, p.x0, p.y0, dx, dy);
    } else {
      look(e.clientX - p.x, e.clientY - p.y, 0.004); // mouse, pointer not locked
    }
    p.x = e.clientX;
    p.y = e.clientY;
  });

  const end = e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    if (p.stick) hideStick(p.stick);
    // iOS and iframes refuse pointer lock; drag-look still works
    const click = e.type === 'pointerup' && e.pointerType === 'mouse' && performance.now() - p.t0 < TAP_MS &&
      Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < TAP_PX;
    if (click && document.pointerLockElement !== canvas && canvas.requestPointerLock) {
      try { canvas.requestPointerLock()?.catch?.(() => {}); } catch {}
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  addEventListener('keydown', e => { if (!e.repeat) keys.add(e.code); });
  addEventListener('keyup', e => keys.delete(e.code));
  // after an app switch keyup / pointerup never arrive
  const reset = () => {
    keys.clear();
    ptrs.clear();
    hideStick(move);
    hideStick(turn);
  };
  addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => document.hidden && reset());

  // once per frame, dt in s
  s.poll = dt => {
    const k = c => (keys.has(c) ? 1 : 0);
    let x = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
    let y = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    s.move.x = len ? x : shape(move.x);
    s.move.y = len ? y : shape(move.y);
    s.up = k('Space') + k('KeyE') - k('ShiftLeft') - k('ShiftRight') - k('KeyQ');
    s.yaw -= shape(turn.x) * TURN * dt;
    s.pitch = Math.max(-1.5, Math.min(1.5, s.pitch + shape(turn.y) * TURN * dt));
  };
  return s;
}

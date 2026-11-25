/* Upright, Z-up interior navigation. Camera motion never edits scene geometry. */
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export function lookDirection(yaw, pitch) {
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(pitch)];
}
export function lookAngles(direction) {
  return {yaw: Math.atan2(direction[0], direction[1]), pitch: clamp(Math.atan2(direction[2], Math.hypot(direction[0], direction[1])), -Math.PI * .47, Math.PI * .47)};
}
export function movementDelta(yaw, input, distance) {
  const length = Math.max(1, Math.hypot(...input)), [forward, right, up] = input.map(n => n / length * distance);
  return [Math.sin(yaw) * forward + Math.cos(yaw) * right, Math.cos(yaw) * forward - Math.sin(yaw) * right, up];
}
export function attachExplore(view) {
  const canvas = view.renderer.domElement, abort = new AbortController(), signal = abort.signal;
  const root = document.createElement('div'); root.className = 'explore-controls'; root.hidden = true;
  root.innerHTML = '<span class="explore-hint">Drag to look · WASD / arrows to move · Q/E down/up · Shift faster</span>' +
    '<button class="explore-stick" aria-label="Move through room" title="Drag to move; arrow keys also work"><span class="stick-directions" aria-hidden="true">↑<br>← &nbsp; →<br>↓</span><span class="stick-thumb"></span></button>' +
    '<div class="explore-height"><button data-rise="1" aria-label="Raise viewpoint" title="Raise viewpoint">↑</button><button data-rise="-1" aria-label="Lower viewpoint" title="Lower viewpoint">↓</button></div>';
  view.plot.append(root);
  const stick = root.querySelector('.explore-stick'), thumb = root.querySelector('.stick-thumb');
  let enabled = false, saved = null, yaw = 0, pitch = 0, keys = new Set(), pad = [0, 0], rise = 0, frame = 0, previous = 0, looking = null, stickPointer = null;
  const speed = () => Number(document.getElementById('explore-speed').value) || 1;
  const input = () => [(keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + pad[0],
    (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + pad[1],
    (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0) + rise];
  function aim() {
    const direction = lookDirection(yaw, pitch), distance = Math.max(.1, view.unit * .3);
    view.controls.target.copy(view.camera.position);
    ['x','y','z'].forEach((axis, i) => { view.controls.target[axis] += direction[i] * distance; });
    view.camera.up.set(0, 0, 1); view.camera.lookAt(view.controls.target); view.invalidate();
  }
  function move(amount, distance) {
    const delta = movementDelta(yaw, amount, distance);
    ['x','y','z'].forEach((axis, i) => { view.camera.position[axis] += delta[i]; }); aim();
  }
  function tick(now) {
    frame = 0;
    if (!enabled || document.hidden || view.disposed) { stop(); return; }
    const dt = previous ? clamp((now - previous) / 1000, 0, .05) : 0; previous = now;
    const amount = input();
    if (amount.some(n => n !== 0)) {
      move(amount, speed() * dt * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1));
      frame = requestAnimationFrame(tick);
    } else previous = 0;
  }
  function wake() { if (enabled && !frame) frame = requestAnimationFrame(tick); }
  function stop() {
    keys.clear(); pad = [0, 0]; rise = 0; looking = null; stickPointer = null;
    thumb.style.transform = ''; cancelAnimationFrame(frame); frame = 0; previous = 0;
  }
  function syncAngles() {
    const d = ['x','y','z'].map(a => view.controls.target[a] - view.camera.position[a]);
    ({yaw, pitch} = lookAngles(d));
  }
  const codes = new Set(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight']);
  view.plot.addEventListener('keydown', event => {
    if (!enabled || !codes.has(event.code) || !event.target.closest('canvas,.explore-controls')) return;
    event.preventDefault(); event.stopPropagation(); keys.add(event.code); wake();
  }, {signal});
  window.addEventListener('keyup', event => { keys.delete(event.code); }, {signal});
  window.addEventListener('blur', stop, {signal});
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); }, {signal});
  view.plot.addEventListener('focusout', event => { if (!view.plot.contains(event.relatedTarget)) stop(); }, {signal});
  canvas.addEventListener('pointerdown', event => {
    if (!enabled || event.button !== 0 || looking) return;
    event.preventDefault(); canvas.focus({preventScroll:true}); canvas.setPointerCapture(event.pointerId);
    looking = {id:event.pointerId,x:event.clientX,y:event.clientY};
  }, {signal});
  canvas.addEventListener('pointermove', event => {
    if (!enabled || !looking || looking.id !== event.pointerId) return;
    const sensitivity = 2.6 / Math.max(180, canvas.clientHeight);
    yaw += (event.clientX - looking.x) * sensitivity;
    pitch = clamp(pitch - (event.clientY - looking.y) * sensitivity, -Math.PI * .47, Math.PI * .47);
    looking.x = event.clientX; looking.y = event.clientY; aim();
  }, {signal});
  const endLook = event => { if (looking?.id === event.pointerId) looking = null; };
  for (const type of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(type,endLook,{signal});
  canvas.addEventListener('wheel', event => {
    if (!enabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    move([clamp(-event.deltaY * scale * .003, -1, 1),clamp(event.deltaX * scale * .003, -1, 1),0],speed());
  }, {passive:false,signal});
  function setPad(event) {
    const rect = stick.getBoundingClientRect(), dx = (event.clientX - rect.x - rect.width / 2) / (rect.width * .34), dy = (event.clientY - rect.y - rect.height / 2) / (rect.height * .34);
    const length = Math.hypot(dx,dy), factor = length > 1 ? 1 / length : 1;
    pad = length < .12 ? [0,0] : [-dy * factor,dx * factor];
    thumb.style.transform = `translate(${pad[1] * 24}px,${-pad[0] * 24}px)`; wake();
  }
  stick.addEventListener('pointerdown', event => {
    if (!enabled || event.button !== 0) return;
    event.preventDefault(); stick.focus({preventScroll:true}); stick.setPointerCapture(event.pointerId); stickPointer = event.pointerId; setPad(event);
  }, {signal});
  stick.addEventListener('pointermove', event => { if (event.pointerId === stickPointer) setPad(event); }, {signal});
  const endPad = event => { if (event.pointerId === stickPointer) { pad = [0,0]; stickPointer = null; thumb.style.transform = ''; } };
  for (const type of ['pointerup','pointercancel','lostpointercapture']) stick.addEventListener(type,endPad,{signal});
  for (const button of root.querySelectorAll('[data-rise]')) {
    button.addEventListener('pointerdown', event => {
      if (!enabled || event.button !== 0) return;
      event.preventDefault(); button.focus({preventScroll:true}); button.setPointerCapture(event.pointerId); rise = Number(button.dataset.rise); wake();
    }, {signal});
    for (const type of ['pointerup','pointercancel','lostpointercapture']) button.addEventListener(type,()=>{ rise = 0; },{signal});
    button.addEventListener('click', event => { if (enabled && !event.detail) move([0,0,Number(button.dataset.rise)],speed() * .2); },{signal});
  }
  return {
    get enabled() { return enabled; },
    snapshot() { return enabled ? {navigation:'explore', inspect:saved} : {navigation:'inspect'}; },
    enter(inspection) { saved = inspection; enabled = true; view.controls.enabled = false; root.hidden = false; canvas.setAttribute('aria-label','3D cloud: drag to look, WASD or movement pad to move'); syncAngles(); },
    leave() { const previous = saved; stop(); enabled = false; saved = null; root.hidden = true; view.controls.enabled = true; canvas.setAttribute('aria-label','3D cloud: drag to orbit, Shift-drag to pan, scroll to zoom'); return previous; },
    restore(state) {
      if (state.navigation === 'explore' && view.canExplore) { this.enter(state.inspect || null); }
      else if (enabled) this.leave();
    },
    place(photo) {
      stop(); view.camera.position.set(...photo.position); ({yaw,pitch} = lookAngles(photo.direction)); aim();
      canvas.focus({preventScroll:true});
    },
    gesture(delta) { if (enabled) move([1,0,0],clamp(delta,-1,1) * speed()); },
    stop,
    dispose() { stop(); abort.abort(); root.remove(); },
  };
}

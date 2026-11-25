/* Axis-constrained camera navigation. The overlay never joins the saved scene. */
import * as THREE from './vendor/three/three.module.js';

const AXES = [
  {name:'x', axis:[1,0,0], u:[0,1,0], v:[0,0,1]},
  {name:'y', axis:[0,1,0], u:[0,0,1], v:[1,0,0]},
  {name:'z', axis:[0,0,1], u:[1,0,0], v:[0,1,0]},
];
const TAU = 2 * Math.PI, STEPS = 128;
const vector = values => new THREE.Vector3(...values);
const svgNS = 'http://www.w3.org/2000/svg';

export function syncOrbitFrame(controls, clearMotion = false) {
  // The locally vendored OrbitControls caches this transform in its constructor.
  // Changing camera.up alone leaves its spherical frame stale (and can snap the
  // view on the next update). Keep this adapter covered against that exact copy.
  controls.object.up.normalize();
  controls._quat.setFromUnitVectors(controls.object.up, new THREE.Vector3(0,1,0));
  controls._quatInverse.copy(controls._quat).invert();
  if (clearMotion) {
    controls._sphericalDelta.set(0,0,0); controls._panOffset.set(0,0,0);
    controls._scale = 1; controls._performCursorZoom = false;
  }
}

export function rotateOrbit(camera, pivot, initial, axis, angle) {
  const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  camera.position.copy(initial.eye).sub(pivot).applyQuaternion(rotation).add(pivot);
  camera.up.copy(initial.up).applyQuaternion(rotation).normalize();
  camera.lookAt(pivot); camera.updateMatrixWorld();
}

export function projectRings(camera, pivot, width, height) {
  if (width <= 0 || height <= 0) return null;
  camera.updateMatrixWorld();
  const project = p => {
    const q = p.clone().project(camera);
    return [(q.x + 1) * width / 2, (1 - q.y) * height / 2, q.z];
  };
  const center = project(pivot);
  if (center[2] < -1 || center[2] > 1 || !center.every(Number.isFinite)) return null;
  const pixels = Math.min(170, Math.min(width,height) * .30);
  const worldHeight = camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom
    : 2 * camera.position.distanceTo(pivot) * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
  const radius = pixels * worldHeight / height;
  const rings = AXES.map(spec => {
    const axis = vector(spec.axis), u = vector(spec.u), v = vector(spec.v);
    const at = angle => project(pivot.clone().addScaledVector(u, Math.cos(angle) * radius).addScaledVector(v, Math.sin(angle) * radius));
    return {...spec, axis, u, v, at, points:Array.from({length:STEPS + 1}, (_,i) => at(TAU * i / STEPS))};
  });
  return {center, radius, pixels, width, height, rings};
}

export function hitRing(layout, pointer, pointerType = 'mouse') {
  if (!layout) return null;
  const tolerance = pointerType === 'touch' ? 22 : 7;
  let best = null;
  for (const ring of layout.rings) for (let i = 0; i < ring.points.length - 1; i++) {
    const a = ring.points[i], b = ring.points[i + 1];
    if (a[2] < -1 || a[2] > 1 || b[2] < -1 || b[2] > 1) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0,Math.min(1,((pointer[0] - a[0]) * dx + (pointer[1] - a[1]) * dy) / length2)) : 0;
    const distance = Math.hypot(pointer[0] - a[0] - dx * t, pointer[1] - a[1] - dy * t), depth = a[2] + (b[2] - a[2]) * t;
    if (distance <= tolerance && (!best || distance < best.distance - .5 || Math.abs(distance - best.distance) <= .5 && depth < best.depth)) {
      best = {ring, distance, depth, angle:TAU * (i + t) / STEPS};
    }
  }
  return best;
}

function planeAngle(drag, pointer) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(pointer[0] / drag.width * 2 - 1, 1 - pointer[1] / drag.height * 2), drag.camera);
  const point = ray.ray.intersectPlane(drag.plane, new THREE.Vector3());
  if (!point) return null;
  point.sub(drag.pivot);
  if (point.length() < drag.radius * .08) return null;
  return Math.atan2(point.dot(drag.ring.v),point.dot(drag.ring.u));
}

export function beginRingDrag(camera, pivot, layout, hit, pointer) {
  const ring = hit.ring, before = ring.at(hit.angle - .01), after = ring.at(hit.angle + .01);
  let tangent = [after[0] - before[0],after[1] - before[1]];
  if (Math.hypot(...tangent) < layout.pixels * .001) {
    // At the tip of an edge-on ellipse its derivative vanishes. Keep a useful
    // screen drag along the visible diameter instead of amplifying roundoff.
    tangent = [ring.at(0),ring.at(Math.PI/2)].map(p => [p[0] - layout.center[0],p[1] - layout.center[1]])
      .sort((a,b) => Math.hypot(...b) - Math.hypot(...a))[0];
  }
  const length = Math.hypot(...tangent) || 1;
  const direction = camera.position.clone().sub(pivot).normalize();
  const drag = {camera:camera.clone(), eye:camera.position.clone(), up:camera.up.clone(), pivot:pivot.clone(), ring,
    width:layout.width, height:layout.height, radius:layout.radius, pixels:layout.pixels,
    start:pointer.slice(), tangent:tangent.map(n => n / length), plane:new THREE.Plane().setFromNormalAndCoplanarPoint(ring.axis,pivot),
    edgeOn:Math.abs(direction.dot(ring.axis)) < .18, previous:null, total:0};
  drag.camera.updateMatrixWorld(); drag.previous = planeAngle(drag,pointer);
  if (drag.previous === null) drag.edgeOn = true;
  return drag;
}

export function ringDragAngle(drag, pointer) {
  if (drag.edgeOn) return -((pointer[0] - drag.start[0]) * drag.tangent[0] + (pointer[1] - drag.start[1]) * drag.tangent[1]) / drag.pixels;
  const angle = planeAngle(drag,pointer);
  if (angle === null) return -drag.total;
  const step = angle - drag.previous;
  drag.total += Math.atan2(Math.sin(step),Math.cos(step)); drag.previous = angle;
  // Dragging a visible ring follows the hand, so the viewing camera turns the
  // opposite way around the fixed world axis.
  return -drag.total;
}

export function ringGestureAllowed(event, {enabled, explore, measuring, controls, photoHit}) {
  return enabled && !explore && !measuring && controls.enabled && controls._pointers.length === 0
    && event.button === 0 && event.isPrimary !== false && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !photoHit;
}

export function attachInspectRings(view, {photoHit, start, hover}) {
  const canvas = view.renderer.domElement, abort = new AbortController(), signal = abort.signal;
  const root = document.createElement('div'); root.className = 'inspect-rings';
  root.setAttribute('aria-hidden','true');
  const svg = document.createElementNS(svgNS,'svg'); root.append(svg);
  const paths = AXES.map(({name}) => {
    const path = document.createElementNS(svgNS,'path'); path.setAttribute('class',`inspect-ring inspect-ring-${name}`);
    path.dataset.axis = name; svg.append(path); return path;
  });
  const toggle = document.createElement('button'); toggle.className = 'inspect-rings-toggle';
  toggle.setAttribute('aria-label','Show axis rotation rings'); toggle.setAttribute('aria-pressed','true');
  toggle.title = 'Show/hide rotation rings · drag a ring around the pivot';
  toggle.innerHTML = '<svg viewBox="0 0 28 28" aria-hidden="true"><ellipse cx="14" cy="14" rx="11" ry="5"/><ellipse cx="14" cy="14" rx="11" ry="5" transform="rotate(60 14 14)"/><ellipse cx="14" cy="14" rx="11" ry="5" transform="rotate(120 14 14)"/></svg>';
  view.plot.append(root,toggle);
  let enabled = true, layout = null, hovered = null, drag = null;
  const measuring = () => document.getElementById('measure')?.checked || view.measurements?.editing;
  const pointer = event => { const rect = canvas.getBoundingClientRect(); return [event.clientX - rect.left,event.clientY - rect.top]; };
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  function render() {
    toggle.hidden = view.explore.enabled;
    root.hidden = !enabled || view.explore.enabled || !!measuring();
    if (root.hidden) { if (drag) finish(); layout = null; hovered = null; if (canvas.style.cursor === 'grab') canvas.style.cursor = ''; return; }
    canvas.setAttribute('aria-label','3D cloud: drag a ring for axis rotation, drag elsewhere to orbit, Shift-drag to pan, scroll to zoom');
    layout = projectRings(view.camera,view.controls.target,view.plot.clientWidth,view.plot.clientHeight);
    root.hidden = !layout;
    if (!layout) return;
    svg.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);
    paths.forEach((path,i) => {
      path.setAttribute('d',layout.rings[i].points.map((p,j) => `${j ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('') + 'Z');
      path.classList.toggle('active',drag?.ring.name === AXES[i].name);
      path.classList.toggle('hovered',!drag && hovered === AXES[i].name);
    });
    root.classList.toggle('dragging',!!drag);
    view.plot.dataset.inspectRings = enabled ? 'on' : 'off';
  }
  function finish({release = true} = {}) {
    if (!drag) return false;
    const id = drag.id; drag = null; hovered = null;
    view.controls.enabled = !view.explore.enabled;
    syncOrbitFrame(view.controls,true);
    canvas.style.cursor = ''; delete view.plot.dataset.rotationAxis;
    if (release && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    view.invalidate(); return true;
  }
  toggle.addEventListener('click',() => {
    finish(); enabled = !enabled; toggle.setAttribute('aria-pressed',String(enabled));
    view.plot.dataset.inspectRings = enabled ? 'on' : 'off'; render();
  },{signal});
  canvas.addEventListener('pointerdown',event => {
    if (drag) {
      if (event.pointerType === 'touch' && drag.pointerType === 'touch' && event.pointerId !== drag.id) {
        // Resume the vendored controls with the first live contact at its
        // CURRENT position (including page scroll), then let the real second
        // pointerdown proceed. Do not dispatch a synthetic click/photo pick.
        const first = drag.last;
        finish({release:false}); view.controls._onPointerDown(first);
      } else consume(event);
      return;
    }
    if (!ringGestureAllowed(event,{enabled,explore:view.explore.enabled,measuring:measuring(),controls:view.controls,photoHit:photoHit(event)})) return;
    render(); const point = pointer(event), hit = hitRing(layout,point,event.pointerType); if (!hit) return;
    consume(event); start(); syncOrbitFrame(view.controls,true);
    drag = beginRingDrag(view.camera,view.controls.target,layout,hit,point);
    Object.assign(drag,{id:event.pointerId,pointerType:event.pointerType,last:contact(event)});
    view.controls.enabled = false; canvas.focus({preventScroll:true}); canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing'; view.plot.dataset.rotationAxis = hit.ring.name;
    view.invalidate();
  },{capture:true,signal});
  function contact(event) {
    return {pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,button:0,buttons:1,
      clientX:event.clientX,clientY:event.clientY,pageX:event.pageX,pageY:event.pageY};
  }
  canvas.addEventListener('pointermove',event => {
    if (drag) {
      if (event.pointerId !== drag.id) return;
      consume(event); drag.last = contact(event);
      rotateOrbit(view.camera,drag.pivot,drag,drag.ring.axis,ringDragAngle(drag,pointer(event)));
      view.controls.target.copy(drag.pivot); syncOrbitFrame(view.controls,true); view.controls.update(); view.invalidate();
    } else {
      const next = ringGestureAllowed({button:0,isPrimary:event.isPrimary,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey},{enabled,explore:view.explore.enabled,measuring:measuring(),controls:view.controls,photoHit:photoHit(event)}) && !event.buttons
        ? hitRing(layout,pointer(event),event.pointerType)?.ring.name : null;
      if (next !== hovered) { hovered = next; view.invalidate(); }
      if (next) { hover(); canvas.style.cursor = 'grab'; event.stopImmediatePropagation(); }
    }
  },{capture:true,signal});
  for (const type of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(type,event => {
    if (drag?.id !== event.pointerId) return;
    consume(event); finish();
  },{capture:true,signal});
  canvas.addEventListener('pointerleave',() => { if (!drag) { hovered = null; view.invalidate(); } },{signal});
  canvas.addEventListener('keydown',event => {
    if (event.key === 'Escape' && finish()) consume(event);
  },{capture:true,signal});
  canvas.addEventListener('dblclick',event => {
    if (enabled && !view.explore.enabled && !measuring() && hitRing(layout,pointer(event)) && !photoHit(event)) consume(event);
  },{capture:true,signal});
  for (const type of ['wheel','gesturestart']) canvas.addEventListener(type,() => finish(),{capture:true,passive:true,signal});
  window.addEventListener('blur',() => finish(),{signal});
  view.plot.addEventListener('focusout',event => { if (!view.plot.contains(event.relatedTarget)) finish(); },{signal});
  document.addEventListener('visibilitychange',() => { if (document.hidden) finish(); },{signal});
  document.addEventListener('planrec-controls-updated',() => { if (measuring()) finish(); render(); },{signal});
  return {render, cancel:finish, get active() { return !!drag; },
    dispose() { finish(); abort.abort(); root.remove(); toggle.remove(); }};
}

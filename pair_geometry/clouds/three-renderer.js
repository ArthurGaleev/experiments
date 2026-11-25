/* A point-cloud renderer for the shared report controls. All data remain immutable. */
import * as THREE from './vendor/three/three.module.js';
import {OrbitControls} from './vendor/three/OrbitControls.js';
const assetQuery = new URL(import.meta.url).search;
const [{attachExplore},{cloudMatrix,segmentDistance2D,supportedIndices,supportingPhotoNames},{clipping,insideClip,readControls,hashText},{attachRulers,clearMeasurements,setMeasuring,refreshMeasurements},{attachInspectRings,syncOrbitFrame}] = await Promise.all([
  import('./explore-controls.js' + assetQuery),import('./cloud-buffers.js' + assetQuery),import('./viewer-tools.js' + assetQuery),import('./ruler-tools.js' + assetQuery),import('./inspect-rings.js' + assetQuery),
]);
export {clearMeasurements, setMeasuring, refreshMeasurements};

const views = new Map();
const axes = ['x', 'y', 'z'];
const pointVertex = `
  attribute vec3 color;
  varying vec3 pointColor;
  varying vec3 worldPosition;
  uniform float pointSize;
  void main() {
    pointColor = color;
    worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = pointSize;
  }`;
const pointFragment = `
  varying vec3 pointColor;
  varying vec3 worldPosition;
  uniform int clipCount;
  uniform vec4 clipPlanes[3];
  uniform bool usePhoto;
  uniform vec3 solidColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    for (int i = 0; i < 3; i++) {
      if (i < clipCount && dot(clipPlanes[i], vec4(worldPosition, 1.0)) < 0.0) discard;
    }
    if (dot(p, p) > 0.25) discard;
    gl_FragColor = vec4(usePhoto ? pointColor : solidColor, 1.0);
  }`;

function disposeObject(object) {
  object.traverse(child => {
    child.geometry?.dispose();
    if (child.material) {
      child.material.map?.dispose();
      child.material.dispose();
    }
  });
}

function cameraState(view) {
  const {camera, controls, center, unit} = view;
  return {
    eye: Object.fromEntries(axes.map(a => [a, (camera.position[a] - center[a]) / unit])),
    center: Object.fromEntries(axes.map(a => [a, (controls.target[a] - center[a]) / unit])),
    up: Object.fromEntries(axes.map(a => [a, camera.up[a]])),
    scale: camera.isOrthographicCamera ? camera.top / camera.zoom / unit : camera.position.distanceTo(controls.target) * Math.tan(Math.PI / 8) / unit,
    projection: camera.isOrthographicCamera ? 'orthographic' : 'perspective',
    ...view.explore.snapshot(),
  };
}

function projection(view) {
  const orthographic = document.getElementById('projection').value === 'orthographic';
  if (!!view.camera.isOrthographicCamera === orthographic) return;
  view.rotation?.cancel();
  const old = view.camera;
  const half = old.isOrthographicCamera ? old.top / old.zoom : old.position.distanceTo(view.controls.target) * Math.tan(Math.PI / 8);
  const aspect = Math.max(1, view.plot.clientWidth) / Math.max(1, view.plot.clientHeight);
  const camera = orthographic ? new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, old.near, old.far)
    : new THREE.PerspectiveCamera(45, aspect, old.near, old.far);
  camera.up.copy(old.up); camera.position.copy(old.position);
  if (!orthographic) camera.position.sub(view.controls.target).normalize().multiplyScalar(half / Math.tan(Math.PI / 8)).add(view.controls.target);
  camera.lookAt(view.controls.target); view.camera = camera; view.controls.object = camera;
  syncOrbitFrame(view.controls,true);
  view.plot.dataset.projection = orthographic ? 'orthographic' : 'perspective';
}
function setCamera(view, state) {
  view.rotation?.cancel();
  view.settingCamera = true;
  const {camera, controls, center, unit} = view;
  const aspect = Math.max(1, view.plot.clientWidth) / Math.max(1, view.plot.clientHeight);
  const up = state.up;
  camera.up.set(up?.x ?? 0, up?.y ?? 0, up?.z ?? 1);
  if (!camera.up.toArray().every(Number.isFinite) || camera.up.lengthSq() < 1e-12) camera.up.set(0,0,1);
  camera.up.normalize();
  controls.target.set(...axes.map(a => center[a] + (state.center?.[a] || 0) * unit));
  camera.position.set(...axes.map(a => center[a] + state.eye[a] * unit));
  let half = (state.scale || camera.position.distanceTo(controls.target) / unit * Math.tan(Math.PI / 8)) * unit;
  if (state.fit && view.spans) {
    const radius = Math.hypot(...view.spans) / 2;
    const halfAngle = Math.atan(Math.tan(Math.PI / 8) * Math.min(1, aspect));
    camera.position.sub(controls.target).normalize().multiplyScalar(radius / Math.sin(halfAngle) * 1.05).add(controls.target);
    half = radius / Math.min(1, aspect) * 1.05;
  }
  if (camera.isOrthographicCamera) {
    camera.top = half; camera.bottom = -half; camera.left = -half * aspect; camera.right = half * aspect; camera.zoom = 1;
  } else if (state.scale && !state.fit) {
    camera.position.sub(controls.target).normalize().multiplyScalar(half / Math.tan(Math.PI / 8)).add(controls.target);
  }
  view.explore.restore(state);
  syncOrbitFrame(controls,true);
  camera.updateProjectionMatrix(); camera.lookAt(controls.target);
  if (!view.explore.enabled) controls.update();
  view.settingCamera = false;
  view.plot.dataset.navigation = view.explore.enabled ? 'explore' : 'inspect'; view.invalidate();
}
export function navigate(plot, mode, photoId) {
  const view = views.get(plot); if (!view) return false;
  if (mode === 'explore' && !view.canExplore) return false;
  view.rotation.cancel();
  cancelAnimationFrame(view.transition);
  if (mode === 'inspect') {
    const saved = view.explore.leave();
    if (saved) {
      document.getElementById('projection').value = saved.projection || 'perspective';
      projection(view); setCamera(view, saved);
    }
  } else {
    if (!view.explore.enabled) {
      const saved = cameraState(view);
      document.getElementById('projection').value = 'perspective'; projection(view);
      view.explore.enter(saved);
    }
    const photos = view.photoViews || [];
    const nearest = photos.slice().sort((a,b) => view.controls.target.distanceToSquared(new THREE.Vector3(...a.position)) - view.controls.target.distanceToSquared(new THREE.Vector3(...b.position)))[0];
    const photo = photos.find(p => p.id === photoId) || nearest;
    if (photo) { view.explore.place(photo); view.plot.dataset.viewpoint = photo.id; }
  }
  view.plot.dataset.navigation = view.explore.enabled ? 'explore' : 'inspect';
  plot.dispatchEvent(new CustomEvent('planrec-navigation',{bubbles:true,detail:{mode:view.plot.dataset.navigation,photoId:view.plot.dataset.viewpoint}}));
  view.invalidate(); return true;
}
const directions = {top:[0,0,1], bottom:[0,0,-1], front:[0,-1,0], back:[0,1,0], left:[-1,0,0], right:[1,0,0], iso:[1.35,-1.8,.8]};
export function orient(plot, name, animate = true) {
  const view = views.get(plot), direction = directions[name]; if (!view || !direction) return;
  if (view.explore.enabled) navigate(plot,'inspect');
  cancelAnimationFrame(view.transition);
  const saved = cameraState(view), start = view.camera.position.clone().sub(view.controls.target), distance = start.length();
  const rotation = new THREE.Quaternion().setFromUnitVectors(start.clone().normalize(), new THREE.Vector3(...direction).normalize());
  const began = performance.now(), duration = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 240 : 0;
  const step = now => {
    if (view.disposed) return;
    const t = duration ? Math.min(1, (now - began) / duration) : 1, eased = t * t * (3 - 2 * t);
    const vector = start.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(rotation, eased)).multiplyScalar(distance / view.unit);
    setCamera(view, {...saved, up:{x:0,y:0,z:1}, eye:Object.fromEntries(axes.map(a => [a, saved.center[a] + vector[a]]))});
    announceCamera(view);
    if (t < 1) view.transition = requestAnimationFrame(step);
  };
  step(began);
}
function orientationWidget(view) {
  const widget = document.createElement('div'); widget.className = 'orientation-widget'; widget.setAttribute('aria-label','View orientation');
  const items = [['right','X',[1,0,0]],['left','−X',[-1,0,0]],['back','Y',[0,1,0]],['front','−Y',[0,-1,0]],['top','Z',[0,0,1]],['bottom','−Z',[0,0,-1]]];
  view.axesButtons = items.map(([name, text, vector]) => {
    const button = document.createElement('button'); button.textContent = text;
    button.className = 'axis-' + text.slice(-1).toLowerCase(); button.setAttribute('aria-label', name[0].toUpperCase() + name.slice(1) + ' view');
    button.title = button.getAttribute('aria-label'); button.onclick = () => orient(view.plot, name);
    widget.append(button); return {button, vector:new THREE.Vector3(...vector)};
  });
  view.plot.append(widget);
}
function renderOrientation(view) {
  const rotation = view.camera.quaternion.clone().invert();
  for (const {button,vector} of view.axesButtons) {
    const p = vector.clone().applyQuaternion(rotation);
    button.style.left = `${40 + p.x * 29}px`; button.style.top = `${40 - p.y * 29}px`;
    button.style.zIndex = String(Math.round((p.z + 1) * 10)); button.style.opacity = p.z < -.1 ? '.5' : '1';
  }
}

function label(text, color = '#647369', compact = false) {
  const canvas = document.createElement('canvas'); canvas.width = compact ? 64 : 512; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = compact ? 'bold 40px system-ui' : '28px system-ui'; ctx.fillStyle = color; ctx.fillText(text, 6, 44);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: texture, depthTest: false}));
  return sprite;
}

function renderView(view) {
  view.renderer.render(view.scene, view.camera);
  view.plot.dataset.camera = JSON.stringify(cameraState(view));
  view.measurements.render(); renderOrientation(view); view.rotation.render();
}

function cameraHit(view, event) {
  if (view.explore.enabled) return null;
  if (!document.getElementById('cameras').checked || document.getElementById('measure').checked) return null;
  const rect = view.renderer.domElement.getBoundingClientRect();
  const pointer = [event.clientX - rect.left, event.clientY - rect.top];
  let best = null, distance = event.pointerType === 'touch' ? 14 : 8;
  // Only the small camera wireframes are inspected; dense clouds are never picked on hover.
  for (const {object} of view.objects.values()) {
    if (!object.userData.cameraPhoto) continue;
    const positions = object.geometry.attributes.position;
    for (let i = 0; i < positions.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld).project(view.camera);
      const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1).applyMatrix4(object.matrixWorld).project(view.camera);
      if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
      const pixels = p => [(p.x + 1) * rect.width / 2, (1 - p.y) * rect.height / 2];
      const delta = segmentDistance2D(pointer, pixels(a), pixels(b));
      if (delta < distance) { distance = delta; best = object; }
    }
  }
  return best;
}

function cameraHover(view, object, event) {
  if (view.hoveredCamera !== object) {
    if (view.hoveredCamera) {
      view.hoveredCamera.material.color.copy(view.hoveredCamera.userData.baseColor);
      view.hoveredCamera.material.opacity = view.hoveredCamera.userData.baseOpacity;
    }
    view.hoveredCamera = object;
    if (object) { object.material.color.set('#1768cc'); object.material.opacity = 1; }
    view.invalidate();
  }
  view.cameraHint.hidden = !object;
  view.renderer.domElement.style.cursor = object ? 'pointer' : document.getElementById('measure').checked ? 'crosshair' : '';
  if (object) {
    const rect = view.renderer.domElement.getBoundingClientRect();
    view.cameraHint.textContent = `${object.userData.cameraPhoto.name} · click/tap to open photo`;
    view.cameraHint.style.left = `${Math.max(8, Math.min(rect.width - 235, event.clientX - rect.left + 12))}px`;
    view.cameraHint.style.top = `${Math.max(8, Math.min(rect.height - 32, event.clientY - rect.top + 12))}px`;
    view.plot.dataset.hoveredCamera = object.userData.cameraPhoto.id;
  } else delete view.plot.dataset.hoveredCamera;
}

function pickedPoint(hit) {
  // Points.raycast returns the closest point on the ray; use the actual saved vertex.
  return hit.object.isPoints ? new THREE.Vector3().fromBufferAttribute(hit.object.geometry.attributes.position, hit.index).applyMatrix4(hit.object.matrixWorld) : hit.point.clone();
}

function pick(view, event, pointsOnly = false) {
  const rect = view.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
  ray.params.Points.threshold = view.camera.isOrthographicCamera ? view.camera.top / view.camera.zoom * .02 : view.camera.position.distanceTo(view.controls.target) * .008;
  ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
    1 - (event.clientY - rect.top) / rect.height * 2), view.camera);
  const objects = [...view.objects.values()].map(o => o.object).filter(o => o.isPoints || (!pointsOnly && o.isMesh));
  for (const hit of ray.intersectObjects(objects, true)) {
    const point = pickedPoint(hit);
    if (!insideClip(point.toArray(), view.clipPlanes)) continue;
    const {photo, support, supportNames} = hit.object.userData;
    const names = support && supportingPhotoNames(support[hit.index], supportNames);
    const photoLabel = names?.length ? `Fused surfel · ${names.join(', ')}` : photo;
    return {...hit, point, photoLabel};
  }
}

function announceCamera(view) {
  if (view.linkedCamera && !view.settingCamera) {
    view.plot.dispatchEvent(new CustomEvent('planrec-camera-change', {bubbles: true, detail: cameraState(view)}));
  }
}

function makeView(plot) {
  const renderer = new THREE.WebGLRenderer({antialias: false, alpha: false, powerPreference: 'high-performance'});
  renderer.localClippingEnabled = true;
  renderer.setPixelRatio(1); // Comparable across displays and to the old Plotly configuration.
  renderer.setClearColor('#f8faf7');
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  const camera = new THREE.PerspectiveCamera(45, 1, .01, 10000); camera.up.set(0, 0, 1);
  const canvas = renderer.domElement; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D cloud: drag to orbit, Shift-drag to pan, scroll to zoom');
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = .12;
  controls.screenSpacePanning = true; controls.zoomToCursor = true;
  controls.minPolarAngle = .00001; controls.maxPolarAngle = Math.PI - .00001;
  const readout = document.createElement('div'); readout.className = 'cloud-readout';
  const cameraHint = document.createElement('div'); cameraHint.className = 'camera-hint'; cameraHint.hidden = true; cameraHint.setAttribute('role', 'tooltip');
  const view = {plot, renderer, scene, content, camera, controls, readout, cameraHint, center: new THREE.Vector3(),
    unit: 1, frame: 0, objects: new Map(), labels: new THREE.Group(), disposed: false, points: 0, clipPlanes: []};
  scene.add(view.labels); plot.replaceChildren(canvas, readout, cameraHint);
  view.invalidate = () => {
    if (!view.frame && !view.disposed) view.frame = requestAnimationFrame(() => {
      view.frame = 0;
      if (view.disposed) return;
      if (!view.explore.enabled) controls.update();
      renderView(view);
    });
  };
  view.explore = attachExplore(view);
  view.measurements = attachRulers(view, pick); orientationWidget(view);
  view.rotation = attachInspectRings(view,{
    photoHit:event => cameraHit(view,event),
    start:() => { cancelAnimationFrame(view.transition); cameraHover(view,null); },
    hover:() => cameraHover(view,null),
  });
  controls.addEventListener('change', () => { view.invalidate(); announceCamera(view); });
  controls.addEventListener('start', () => { cancelAnimationFrame(view.transition); cameraHover(view, null); });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); readout.textContent = 'Graphics context lost. Reload this page to restore the view.';
  });
  canvas.addEventListener('dblclick', event => {
    if (view.explore.enabled) return;
    if (document.getElementById('measure').checked || cameraHit(view, event)) return;
    const hit = pick(view, event);
    if (hit) {
      controls.target.copy(hit.point); controls.update();
      const name = hit.photoLabel || 'Surface';
      readout.textContent = view.inspection ? `${name} · orbit target set; part placement unknown`
        : `${name} · ${hit.point.toArray().map(v => v.toFixed(2)).join(', ')} ${view.unitLabel}`;
      view.invalidate();
    }
  });
  let down;
  canvas.addEventListener('pointerdown', event => { down = event.isPrimary && event.button === 0 ? [event.clientX, event.clientY] : null; });
  canvas.addEventListener('pointermove', event => cameraHover(view, event.buttons ? null : cameraHit(view, event), event));
  canvas.addEventListener('pointerleave', () => cameraHover(view, null));
  canvas.addEventListener('pointerup', event => {
    if (!view.explore.enabled && down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) < 4) {
      if (document.getElementById('measure').checked) view.measurements.measure(event);
      else {
        const hit = cameraHit(view, event);
        if (hit) plot.dispatchEvent(new CustomEvent('planrec-camera-open', {bubbles: true, detail: {id: hit.userData.cameraPhoto.id}}));
      }
    }
    down = null;
    cameraHover(view, cameraHit(view, event), event);
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Escape' && view.measurements.cancel()) { event.preventDefault(); event.stopPropagation();
    }
    if (event.key.toLowerCase() === 'f') document.getElementById('reset').click();
    if (event.key.toLowerCase() === 't') document.getElementById('top').click();
  });
  // WebKit trackpads can send native pinch events rather than wheel events.
  let gesture;
  const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  canvas.addEventListener('gesturestart', event => {
    stop(event); gesture = {scale: event.scale || 1, eye: view.camera.position.clone(), target: controls.target.clone(), zoom: view.camera.zoom};
  }, {passive: false});
  canvas.addEventListener('gesturechange', event => {
    if (!gesture) return;
    stop(event);
    const factor = Math.max(.05, Math.min(20, gesture.scale / event.scale));
    if (view.explore.enabled) { view.explore.gesture(Math.log((event.scale || 1) / gesture.scale)); gesture.scale = event.scale || 1; return; }
    if (view.camera.isOrthographicCamera) { view.camera.zoom = gesture.zoom / factor; view.camera.updateProjectionMatrix(); }
    else view.camera.position.copy(gesture.eye).sub(gesture.target).multiplyScalar(factor).add(gesture.target);
    controls.update(); view.invalidate();
  }, {passive: false});
  canvas.addEventListener('gestureend', event => { stop(event); gesture = null; }, {passive: false});
  view.resize = () => {
    if (view.disposed) return;
    view.rotation.cancel();
    const width = Math.max(1, plot.clientWidth), height = Math.max(1, plot.clientHeight);
    renderer.setSize(width, height, false);
    if (view.camera.isOrthographicCamera) { view.camera.left = -view.camera.top * width / height; view.camera.right = view.camera.top * width / height; }
    else view.camera.aspect = width / height;
    view.camera.updateProjectionMatrix(); view.invalidate();
  };
  view.observer = new ResizeObserver(view.resize); view.observer.observe(plot);
  view.resize(); views.set(plot, view);
  return view;
}

function pointObject(chunk, cloud, trace) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(chunk.xyz, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(chunk.rgb, 3, true));
  geometry.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({vertexShader: pointVertex, fragmentShader: pointFragment,
    uniforms: {pointSize: {value: 2}, clipCount: {value: 0}, clipPlanes: {value: [new THREE.Vector4(),new THREE.Vector4(),new THREE.Vector4()]}, usePhoto: {value: true}, solidColor: {value: new THREE.Vector3(1, 1, 1)}}});
  const object = new THREE.Points(geometry, material); object.matrixAutoUpdate = false;
  object.userData.photo = trace.name;
  object.userData.support = chunk.support;
  object.userData.supportNames = cloud.supportNames;
  return object;
}

function ordinaryObject(trace, unit) {
  if (trace.mode === 'text') {
    const group = new THREE.Group();
    (trace.text || []).forEach((text, i) => {
      const sprite = label(text, '#8a5513');
      sprite.position.set(trace.x[i], trace.y[i], trace.z[i]);
      sprite.scale.set(unit * .8, unit * .1, 1); group.add(sprite);
    });
    return group;
  }
  const geometry = new THREE.BufferGeometry();
  if (trace.type === 'mesh3d') {
    const xyz = new Float32Array(trace.x.length * 3);
    for (let i = 0; i < trace.x.length; i++) { xyz[i * 3] = trace.x[i]; xyz[i * 3 + 1] = trace.y[i]; xyz[i * 3 + 2] = trace.z[i]; }
    geometry.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    const indices = []; for (let i = 0; i < trace.i.length; i++) indices.push(trace.i[i], trace.j[i], trace.k[i]);
    geometry.setIndex(indices);
    if (trace.vertexcolor) {
      const colors = new Float32Array(trace.x.length * 3), c = new THREE.Color();
      trace.vertexcolor.forEach((color, i) => c.set(color).toArray(colors, i * 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({vertexColors: !!trace.vertexcolor,
      color: trace.color || '#ffffff', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1}));
  }
  const xyz = [];
  for (let i = 1; i < (trace.x?.length || 0); i++) {
    if (axes.every(a => trace[a][i] != null && trace[a][i - 1] != null)) {
      xyz.push(trace.x[i - 1], trace.y[i - 1], trace.z[i - 1], trace.x[i], trace.y[i], trace.z[i]);
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({color: trace.line?.color || '#647369',
    transparent: !!trace.opacity, opacity: trace.opacity ?? 1}));
}

export async function react(plot, data, layout) {
  const view = views.get(plot) || makeView(plot);
  cameraHover(view, null); projection(view);
  const config = layout.scene, ranges = axes.map(a => config[a + 'axis'].range);
  view.linkedCamera = !!config.linkedCamera;
  view.controls.enableDamping = !view.linkedCamera;
  const spans = ranges.map(r => Math.max(.1, r[1] - r[0]));
  view.spans = spans;
  view.center.set(...ranges.map(r => (r[0] + r[1]) / 2));
  view.unit = Math.cbrt(spans[0] * spans[1] * spans[2]);
  view.unitLabel = config.xaxis.title?.text?.includes('rel.') ? 'relative units' : 'm';
  if (config.unitLabel) view.unitLabel = config.unitLabel;
  view.inspection = config.xaxis.visible === false;
  view.photoViews = config.photoViews || [];
  const frames = new Set(data.map(t => (t.cloud || t.surface)?.frame).filter(f => f != null));
  view.canExplore = frames.size === 1 && config.canExplore !== false;
  view.camera.near = Math.max(.0001, view.unit * .0001);
  view.camera.far = Math.max(...spans) * 1000; view.camera.updateProjectionMatrix();
  view.controls.minDistance = view.unit * .0005; view.controls.maxDistance = view.unit * 100;
  const clip = clipping(ranges, readControls()); view.clipPlanes = clip.planes;
  const clippingPlanes = clip.planes.map(p => new THREE.Plane(new THREE.Vector3(...p.slice(0, 3)), p[3]));
  if (view.sectionGuide) { view.scene.remove(view.sectionGuide); disposeObject(view.sectionGuide); view.sectionGuide = null; }
  if (clip.section) {
    const {normal, center, width} = clip.section;
    view.readout.textContent = `Slice center ${center.toFixed(2)} ${view.unitLabel} · width ${width.toFixed(2)} ${view.unitLabel}`;
    if (document.getElementById('section-guide').checked) {
      const span = Math.hypot(...spans), geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(span, span, width));
      const guide = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({color:'#4d86a0',transparent:true,opacity:.45,depthWrite:false,depthTest:false}));
      guide.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), new THREE.Vector3(...normal));
      guide.position.copy(view.center).addScaledVector(new THREE.Vector3(...normal), center - view.center.dot(new THREE.Vector3(...normal)));
      view.sectionGuide = guide; view.scene.add(guide);
    }
  } else view.readout.textContent = '';
  const active = new Set(); view.points = 0;
  for (let index = 0; index < data.length; index++) {
    const trace = data[index];
    if (trace.cloud) {
      const cloud = trace.cloud, matrix = cloudMatrix(cloud.pose, cloud.rotation, cloud.offset);
      for (const chunk of cloud.chunks) {
        const key = `${cloud.id}:${chunk.key}`; active.add(key);
        let entry = view.objects.get(key);
        if (!entry) {
          entry = {object: pointObject(chunk, cloud, trace)};
          view.objects.set(key, entry); view.content.add(entry.object);
        }
        const object = entry.object;
        object.userData.frame = cloud.frame; object.userData.unit = cloud.unitLabel;
        object.matrix.fromArray(matrix); object.matrixWorldNeedsUpdate = true;
        let count = Math.max(0, Math.min(chunk.count, cloud.limit - chunk.start));
        if (chunk.support) {
          const selectionKey = `${cloud.selectionMask}:${count}`;
          if (object.userData.selectionKey !== selectionKey) {
            const indices = supportedIndices(chunk.support, cloud.selectionMask, count);
            if (!object.geometry.index) object.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(chunk.count), 1).setUsage(THREE.DynamicDrawUsage));
            object.geometry.index.array.set(indices);
            object.geometry.index.needsUpdate = true;
            object.userData.visibleCount = indices.length;
            object.userData.selectionKey = selectionKey;
          }
          count = object.userData.visibleCount;
        }
        object.geometry.setDrawRange(0, count); view.points += count;
        object.material.uniforms.pointSize.value = Number(document.getElementById('point-size')?.value || 2);
        object.material.uniforms.clipCount.value = clip.planes.length;
        clip.planes.forEach((p, i) => object.material.uniforms.clipPlanes.value[i].set(...p));
        const color = trace.marker.color;
        object.material.uniforms.usePhoto.value = color === 'photo';
        if (color !== 'photo') {
          const c = new THREE.Color(color).convertLinearToSRGB();
          object.material.uniforms.solidColor.value.set(c.r, c.g, c.b);
        }
      }
    } else {
      const key = `decoration:${index}`; active.add(key);
      const previous = view.objects.get(key);
      if (previous) { view.content.remove(previous.object); disposeObject(previous.object); }
      const object = ordinaryObject(trace, view.unit);
      // Cut reconstructed surfaces, while camera/ruler annotations stay intact.
      if (object.isMesh) {
        object.material.clippingPlanes = clippingPlanes;
        object.userData.photo = trace.name;
        object.userData.frame = trace.surface?.frame;
        object.userData.unit = trace.surface?.unitLabel;
      }
      if (trace.cameraPhoto) {
        object.userData.cameraPhoto = trace.cameraPhoto;
        object.userData.baseColor = object.material.color.clone();
        object.userData.baseOpacity = object.material.opacity;
        object.material.depthTest = false; object.material.depthWrite = false; object.renderOrder = 500;
      }
      view.objects.set(key, {object}); view.content.add(object);
    }
  }
  for (const [key, entry] of view.objects) if (!active.has(key)) {
    view.content.remove(entry.object); disposeObject(entry.object); view.objects.delete(key);
  }
  disposeObject(view.labels); view.scene.remove(view.labels); view.labels = new THREE.Group(); view.scene.add(view.labels);
  if (!view.inspection && document.getElementById('axes').checked) {
    const origin = new THREE.Vector3(...ranges.map(r => r[0]));
    const helper = new THREE.AxesHelper(view.unit * .25); helper.position.copy(origin); view.labels.add(helper);
    axes.forEach((a, i) => {
      const text = label(config[a + 'axis'].title?.text || a);
      text.position.copy(origin); text.position[a] += view.unit * .3;
      text.scale.set(view.unit * .5, view.unit * .0625, 1); view.labels.add(text);
    });
  }
  plot.data = data; plot.layout = layout;
  const signature = hashText(JSON.stringify(data.filter(trace => trace.cloud || trace.surface).map(trace => {
    const source = trace.cloud || trace.surface;
    return [trace.cloud ? 'points' : 'patches', source.id, source.frame, source.pose, source.rotation, source.offset || [0, 0, 0]];
  })));
  if (view.geometrySignature && signature !== view.geometrySignature) view.measurements.clear();
  view.geometrySignature = signature;
  setCamera(view, config.camera);
  renderView(view);
  plot.dataset.renderedPoints = String(view.points);
  plot.dataset.drawCalls = String(view.renderer.info.render.calls);
  plot.dataset.camera = JSON.stringify(cameraState(view));
}

export function inspectionState(plot) { return views.get(plot)?.measurements.snapshot(); }
export function restoreInspection(plot, saved) { views.get(plot)?.measurements.restore(saved); }
export function currentCamera(plot) { const view = views.get(plot); return view && cameraState(view); }
export function relayout(plot, changes) { const view = views.get(plot); if (view && changes['scene.camera']) setCamera(view, changes['scene.camera']); }
export function purge(plot) {
  const view = views.get(plot); if (!view) return;
  view.disposed = true; cancelAnimationFrame(view.frame); cancelAnimationFrame(view.transition);
  view.observer.disconnect(); view.rotation.dispose(); view.controls.dispose();
  view.explore.dispose();
  disposeObject(view.content); disposeObject(view.labels); view.objects.clear();
  view.measurements.dispose(); if (view.sectionGuide) disposeObject(view.sectionGuide);
  view.renderer.dispose(); view.renderer.forceContextLoss();
  views.delete(plot); plot.replaceChildren(); delete plot.data; delete plot.layout;
}
export const Plots = {resize(plot) { views.get(plot)?.resize(); }};

export async function benchmark(plot, frames = 120) {
  const view = views.get(plot);
  if (!view || document.hidden) throw new Error('Keep a visible 3D view open for the measurement');
  const saved = cameraState(view), samples = [];
  const vector = view.camera.position.clone().sub(view.controls.target);
  let previous;
  for (let i = 0; i < frames + 10; i++) {
    const now = await new Promise(requestAnimationFrame);
    if (view.disposed || document.hidden) throw new Error('Measurement interrupted');
    if (i > 10) samples.push(now - previous);
    previous = now;
    vector.applyAxisAngle(new THREE.Vector3(0, 0, 1), .006);
    view.camera.position.copy(view.controls.target).add(vector);
    view.camera.lookAt(view.controls.target); renderView(view);
  }
  setCamera(view, saved);
  const sorted = samples.slice().sort((a, b) => a - b);
  return {renderer: `Three.js ${THREE.REVISION}`, points: view.points, frames: samples.length,
    meanFps: +(1000 / (samples.reduce((a, b) => a + b, 0) / samples.length)).toFixed(1),
    medianFrameMs: +sorted[Math.floor(sorted.length * .5)].toFixed(2),
    p95FrameMs: +sorted[Math.floor(sorted.length * .95)].toFixed(2),
    viewport: [plot.clientWidth, plot.clientHeight], pixelRatio: 1,
    userAgent: navigator.userAgent, note: 'Animation-frame cadence including rendering; not a GPU-only timer.'};
}

/* Static scene viewer. Geometry is immutable; selection changes visibility only. */
(() => {
  'use strict';
  const settings = JSON.parse(document.getElementById('scene-data').textContent);
  const get = id => document.getElementById(id);
  const photoViewer = window.planrecPhotoViewer();
  const palette = ['#168575', '#ce621c', '#6551c5', '#bd3c8a', '#267bb7', '#7c4f37', '#85801d'];
  const defaultCamera = {eye: {x: 1.35, y: -1.8, z: .8}, up: {x: 0, y: 0, z: 1}, center: {x: 0, y: 0, z: 0}};
  const roomCamera = {eye: {x: 0, y: -2.1, z: 1}, up: {x: 0, y: 0, z: 1}, center: {x: 0, y: 0, z: 0}};
  const state = {variant: settings.variants[0], selected: new Set(), limit: settings.defaultLimit, mode: 'points', version: 0, room: null, roomSource: 'pairwise'};
  const semanticVariants = [{id: 'pairwise', label: 'Парные гипотезы', semantics: settings.semantics}, ...(settings.roomVariants || [])].filter(v => v.semantics);
  const sourceRooms = new Map();
  const assets = new Map(), geometry = new Map(), plots = new Map(), cameras = new Map(), selections = new Map();
  const roomSelections = new Map();
  let observer, expanded, scheduled = false, drawing = false;
  const sceneDialog = document.createElement('dialog');
  sceneDialog.className = 'scene-viewer';
  sceneDialog.setAttribute('aria-label', 'Увеличенный 3D-вид');
  document.body.append(sceneDialog);
  sceneDialog.addEventListener('close', () => { if (!sceneDialog.open) collapseScene(); });
  function scheduleDraw() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; draw(); });
    }
  }
  function release(view) {
    // A variant can disappear while Plotly.react is still using its DOM node.
    if (view.rendering) { view.disposed = true; return; }
    if (view.plot.data) { cameras.set(view.key, currentCamera(view.plot)); Plotly.purge(view.plot); }
  }
  const diagnostics = new URLSearchParams(location.search).has('qa');
  let loadedBytes = 0;
  const decode = (value, Type) => new Type(Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer);
  const rotate = (p, r) => r.map(row => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
  const pose = (p, m) => m.slice(0, 3).map(row => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]);
  const position = (p, source, component) => rotate(pose(p, source.pose), get('level').checked ? component.rotation : component.fixed);
  const sourceColour = source => palette[state.variant.sources.indexOf(source) % palette.length];

  // Plotly's touch rotation can leave layout.scene.camera stale. Keep this
  // access to the bundled GL scene in one place, including when suspending views.
  function currentCamera(plot) {
    const camera = plot._fullLayout?.scene?._scene?.getCamera?.() || plot.layout?.scene?.camera;
    return camera ? structuredClone(camera) : undefined;
  }

  function fixedAspect(ranges) {
    const spans = ranges.map(([lo, hi]) => Math.max(hi - lo, 1e-9));
    const unit = Math.cbrt(spans[0] * spans[1] * spans[2]);
    return Object.fromEntries(['x', 'y', 'z'].map((axis, i) => [axis, spans[i] / unit]));
  }

  function resizeScene(view) {
    requestAnimationFrame(() => {
      if (!view.plot.isConnected || !view.plot.data) return;
      Plotly.Plots.resize(view.plot);
    });
  }

  function collapseScene() {
    if (!expanded) return;
    const {view, placeholder, button} = expanded;
    expanded = null;
    if (sceneDialog.open) sceneDialog.close();
    placeholder.replaceWith(view.section);
    document.body.classList.remove('scene-viewer-open');
    button.textContent = '⤢'; button.title = 'Развернуть 3D';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Развернуть 3D');
    button.focus({preventScroll: true});
    resizeScene(view);
  }

  function expandScene(view, button) {
    if (expanded) { collapseScene(); return; }
    const placeholder = document.createElement('div');
    placeholder.className = 'scene-placeholder';
    placeholder.style.height = view.section.getBoundingClientRect().height + 'px';
    view.section.before(placeholder);
    expanded = {view, placeholder, button}; view.nearby = true;
    sceneDialog.append(view.section);
    document.body.classList.add('scene-viewer-open');
    button.textContent = '⤡'; button.title = 'Свернуть 3D (Esc)';
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-label', 'Свернуть 3D');
    sceneDialog.showModal();
    button.focus({preventScroll: true});
    resizeScene(view);
  }

  // Single-finger orbit stays with Plotly; custom gestures only move the view camera.
  function enableNavigation(plot) {
    let active = false, touchCount = 0, start, native, mouse, pending, frame = 0, busy = false;
    const touches = event => [...event.touches].filter(touch => plot.contains(touch.target))
      .sort((a, b) => a.identifier - b.identifier);
    const distance = pair => Math.hypot(pair[0].clientX - pair[1].clientX, pair[0].clientY - pair[1].clientY);
    const angle = pair => Math.atan2(pair[1].clientY - pair[0].clientY, pair[1].clientX - pair[0].clientX);
    const midpoint = pair => [(pair[0].clientX + pair[1].clientX) / 2, (pair[0].clientY + pair[1].clientY) / 2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const options = {capture: true, passive: false};
    function snapshot() {
      const camera = pending || currentCamera(plot);
      return camera && {camera: structuredClone(camera), height: Math.max(1, plot.getBoundingClientRect().height),
        fovy: plot._fullLayout?.scene?._scene?.glplot?.fovy || Math.PI / 4};
    }
    function flush() {
      frame = 0;
      if (!pending || !plot.data) { pending = null; return; }
      const camera = pending; pending = null; busy = true;
      Promise.resolve(Plotly.relayout(plot, {'scene.camera': camera})).finally(() => {
        busy = false;
        if (pending && !frame) frame = requestAnimationFrame(flush);
      });
    }
    function move(base, {zoom = 1, rotation = 0, dx = 0, dy = 0}) {
      if (!(zoom > 0) || ![zoom, rotation, dx, dy].every(Number.isFinite)) return;
      const camera = base.camera, centre = camera.center || {x: 0, y: 0, z: 0};
      const axes = ['x', 'y', 'z'], vector = axes.map(axis => camera.eye[axis] - centre[axis]);
      const radius = Math.hypot(...vector);
      if (radius < 1e-6) return;
      const scale = Math.min(20, Math.max(.1, radius / zoom)) / radius;
      const forward = vector.map(v => -v / radius), originalUp = axes.map(axis => camera.up[axis]);
      const crossedUp = cross(forward, originalUp), rightLength = Math.hypot(...crossedUp);
      if (rightLength < 1e-6) return;
      const right = crossedUp.map(v => v / rightLength), up = cross(right, forward);
      const pixelScale = 2 * radius * Math.tan(base.fovy / 2) / base.height;
      const centreNext = Object.fromEntries(axes.map((axis, i) => [axis,
        centre[axis] + (-right[i] * dx + up[i] * dy) * pixelScale]));
      const eye = Object.fromEntries(axes.map((axis, i) => [axis, centreNext[axis] + vector[i] * scale]));
      // Rotate up opposite to the screen-space angle: the scene follows the fingers.
      const cosine = Math.cos(rotation), sine = Math.sin(rotation);
      // Canonical screen-up survives Plotly recreating a previously hidden scene.
      const rolledUp = rotation ? Object.fromEntries(axes.map((axis, i) => [axis,
        up[i] * cosine - right[i] * sine])) : camera.up;
      pending = {...camera, center: centreNext, eye, up: rolledUp};
      if (!frame && !busy) frame = requestAnimationFrame(flush);
    }
    plot.addEventListener('touchstart', event => {
      const pair = touches(event), base = snapshot(); touchCount = pair.length; native = null;
      if (pair.length === 2 && base) {
        start = {...base, distance: distance(pair), angle: angle(pair), midpoint: midpoint(pair)};
        active = true;
      } else if (active) start = null;
      if (active) stop(event);
    }, options);
    plot.addEventListener('touchmove', event => {
      if (!active) return;
      stop(event);
      const pair = touches(event);
      if (!start || pair.length !== 2 || distance(pair) < 1 || start.distance < 1) return;
      const middle = midpoint(pair);
      move(start, {zoom: distance(pair) / start.distance, rotation: angle(pair) - start.angle,
        dx: middle[0] - start.midpoint[0], dy: middle[1] - start.midpoint[1]});
    }, options);
    const end = event => {
      if (active) event.preventDefault();
      // Let Plotly see releases so its preceding one-finger drag cannot stay active.
      touchCount = touches(event).length;
      if (touchCount < 2) start = null;
      if (!touchCount) active = false;
    };
    plot.addEventListener('touchend', end, options);
    plot.addEventListener('touchcancel', end, options);

    // WebKit exposes trackpad rotation. On touchscreens, avoid handling both streams.
    plot.addEventListener('gesturestart', event => {
      stop(event);
      const base = snapshot();
      if (!touchCount && base) native = {...base, rotation: event.rotation || 0, scale: event.scale || 1};
    }, options);
    plot.addEventListener('gesturechange', event => {
      if (!native && !touchCount) return;
      stop(event);
      if (native && !touchCount) move(native, {zoom: event.scale / native.scale,
        rotation: (event.rotation - native.rotation) * Math.PI / 180});
    }, options);
    plot.addEventListener('gestureend', event => { if (native || touchCount) stop(event); native = null; }, options);
    plot.addEventListener('wheel', event => { if (native) stop(event); }, options);

    // Alt + horizontal mouse drag provides the same roll where trackpad rotation is unavailable.
    plot.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || !event.altKey) return;
      const base = snapshot(); if (!base) return;
      stop(event); mouse = {...base, id: event.pointerId, x: event.clientX};
      plot.setPointerCapture(event.pointerId);
    }, options);
    plot.addEventListener('pointermove', event => {
      if (!mouse || event.pointerId !== mouse.id) return;
      stop(event); move(mouse, {rotation: (event.clientX - mouse.x) * Math.PI / 720});
    }, options);
    const mouseEnd = event => {
      if (!mouse || event.pointerId !== mouse.id) return;
      stop(event); mouse = null;
      if (plot.hasPointerCapture(event.pointerId)) plot.releasePointerCapture(event.pointerId);
    };
    plot.addEventListener('pointerup', mouseEnd, options);
    plot.addEventListener('pointercancel', mouseEnd, options);
    plot.addEventListener('lostpointercapture', () => { mouse = null; }, options);
  }

  function load(asset) {
    if (!assets.has(asset.key)) {
      loadedBytes += asset.bytes;
      assets.set(asset.key, new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = asset.url;
        const fail = error => {
          assets.delete(asset.key); script.remove(); reject(error);
        };
        script.onload = () => {
          try {
            const raw = window.planrecData?.[asset.key];
            if (!raw) throw new Error(asset.url);
            const data = {xyz: decode(raw.xyz, Float32Array), rgb: decode(raw.rgb, Uint8Array)};
            if (raw.triangles) data.triangles = decode(raw.triangles, Uint32Array);
            if (raw.patch) data.patch = decode(raw.patch, Uint16Array);
            script.remove();
            resolve(data);
          } catch (error) { fail(error); }
          finally { if (window.planrecData) delete window.planrecData[asset.key]; }
        };
        script.onerror = () => fail(new Error(asset.url));
        document.head.append(script);
      }));
    }
    return assets.get(asset.key);
  }

  // Connected components of the selected induced graph, including isolated photos.
  function components(ids, edges) {
    const remaining = new Set(ids), adjacent = new Map(ids.map(id => [id, []])), result = [];
    for (const [a, b] of edges) {
      if (adjacent.has(a) && adjacent.has(b)) { adjacent.get(a).push(b); adjacent.get(b).push(a); }
    }
    for (const root of ids) {
      if (!remaining.has(root)) continue;
      const group = [root]; remaining.delete(root);
      for (let i = 0; i < group.length; i++) for (const next of adjacent.get(group[i])) {
        if (remaining.delete(next)) group.push(next);
      }
      result.push(group);
    }
    return result;
  }

  function selectionGroups() {
    const membership = new Map(), counts = new Map(); let next = 0;
    for (const component of state.variant.components) {
      const ids = component.ids.filter(id => state.selected.has(id));
      const groups = state.variant.edges === null ? (ids.length ? [ids] : []) : components(ids, state.variant.edges);
      counts.set(component.id, groups.length);
      for (const group of groups) { for (const id of group) membership.set(id, next); next++; }
    }
    return {membership, counts, total: next};
  }

  // Prune unselected leaves of the original assembly tree: remaining hidden
  // vertices are precisely the intermediaries supporting the visible selection.
  function supportingEdges(component) {
    const adjacent = new Map(component.ids.map(id => [id, new Set()]));
    for (const [a, b] of state.variant.treeEdges) if (adjacent.has(a) && adjacent.has(b)) {
      adjacent.get(a).add(b); adjacent.get(b).add(a);
    }
    const queue = component.ids.filter(id => !state.selected.has(id) && adjacent.get(id).size <= 1);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const other of adjacent.get(id)) {
        adjacent.get(other).delete(id);
        if (!state.selected.has(other) && adjacent.get(other).size === 1) queue.push(other);
      }
      adjacent.get(id).clear();
    }
    return state.variant.treeEdges.filter(([a, b]) => adjacent.get(a)?.has(b));
  }

  async function prepared(source, component, kind) {
    const key = `${state.variant.id}:${source.id}:${kind}`;
    const signature = `${get('level').checked}:${kind === 'points' ? state.limit : ''}`;
    const prior = geometry.get(key);
    if (prior?.signature === signature) return prior.data;
    const rotation = get('level').checked ? component.rotation : component.fixed;
    const chunks = kind === 'points' ? source.chunks.filter(c => c.start < state.limit) : [source.planes];
    const raw = await Promise.all(chunks.map(load));
    const n = raw.reduce((sum, c) => sum + c.xyz.length / 3, 0);
    const data = {x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), rgb: [], patch: []};
    let offset = 0;
    for (const chunk of raw) {
      for (let i = 0; i < chunk.xyz.length; i += 3) {
        const p = rotate(pose([chunk.xyz[i], chunk.xyz[i + 1], chunk.xyz[i + 2]], source.pose), rotation);
        data.x[offset] = p[0]; data.y[offset] = p[1]; data.z[offset] = p[2];
        data.rgb.push(`rgb(${chunk.rgb[i]},${chunk.rgb[i + 1]},${chunk.rgb[i + 2]})`);
        if (chunk.patch) data.patch.push(palette[chunk.patch[i / 3] % palette.length]);
        offset++;
      }
    }
    if (kind === 'planes') {
      const faces = raw[0].triangles;
      data.i = []; data.j = []; data.k = [];
      for (let i = 0; i < faces.length; i += 3) { data.i.push(faces[i]); data.j.push(faces[i + 1]); data.k.push(faces[i + 2]); }
    }
    geometry.set(key, {signature, data});
    return data;
  }

  function colour(source, groups, data, kind) {
    switch (get('colour').value) {
      case 'source': return sourceColour(source);
      case 'group': return palette[(groups.membership.get(source.id) || 0) % palette.length];
      case 'patch': return kind === 'planes' ? data.patch : '#b5bdb6';
      default: return data.rgb;
    }
  }

  function cameraTrace(source, component, groups, ghost = false) {
    const centre = position([0, 0, 0], source, component), lines = [];
    const corners = source.corners.map(p => position(p, source, component));
    for (let i = 0; i < 4; i++) lines.push(centre, corners[i], corners[(i + 1) % 4], [null, null, null]);
    return {type: 'scatter3d', mode: 'lines', x: lines.map(p => p[0]), y: lines.map(p => p[1]), z: lines.map(p => p[2]),
      name: `${ghost ? 'Скрытое фото' : 'Камера'}: ${source.name}`, showlegend: false, hoverinfo: 'name',
      opacity: ghost ? .3 : 1, line: {width: ghost ? 2 : 4, color: ghost ? '#89958c' : palette[(groups.membership.get(source.id) || 0) % palette.length]}};
  }

  async function traces(component, groups) {
    const sources = state.variant.sources.filter(s => component.ids.includes(s.id));
    const selected = sources.filter(s => state.selected.has(s.id));
    const output = (await Promise.all(selected.map(async source => {
      const list = [], hover = 'x: %{x:.2f} м<br>y: %{y:.2f} м<br>z: %{z:.2f} м<extra>' + source.name + '</extra>';
      if (state.mode !== 'planes') {
        const data = await prepared(source, component, 'points');
        list.push({type: 'scatter3d', mode: 'markers', name: source.name, x: data.x, y: data.y, z: data.z,
          marker: {size: 2, color: colour(source, groups, data, 'points')}, showlegend: false, hovertemplate: hover});
      }
      if (state.mode !== 'points' && source.planes?.triangles) {
        const data = await prepared(source, component, 'planes'), colors = colour(source, groups, data, 'planes');
        list.push({type: 'mesh3d', name: source.name, x: data.x, y: data.y, z: data.z, i: data.i, j: data.j, k: data.k,
          ...(typeof colors === 'string' ? {color: colors} : {vertexcolor: colors}), flatshading: true,
          lighting: {ambient: .8, diffuse: .35, specular: 0}, showlegend: false, hovertemplate: hover});
      }
      if (get('cameras').checked) list.push(cameraTrace(source, component, groups));
      return list;
    }))).flat();
    if (get('paths').checked && !state.room) {
      const edges = supportingEdges(component), hidden = new Set(), line = [];
      const byId = new Map(sources.map(s => [s.id, s]));
      for (const [a, b] of edges) {
        const hiddenEdge = !state.selected.has(a) || !state.selected.has(b);
        if (!hiddenEdge) continue;
        for (const id of [a, b]) if (!state.selected.has(id)) hidden.add(id);
        line.push(position([0, 0, 0], byId.get(a), component), position([0, 0, 0], byId.get(b), component), [null, null, null]);
      }
      if (line.length) output.push({type: 'scatter3d', mode: 'lines', x: line.map(p => p[0]), y: line.map(p => p[1]), z: line.map(p => p[2]),
        line: {color: '#89958c', width: 3, dash: 'dash'}, name: 'Путь через скрытые фото', hoverinfo: 'name', showlegend: false});
      for (const id of hidden) output.push(cameraTrace(byId.get(id), component, groups, true));
    }
    if (get('cameras').checked && !state.room) {
      const rotation = get('level').checked ? component.rotation : component.fixed;
      for (const [up, label, color] of [[component.up, 'Вверх · GeoCalib', '#168575'], [settings.referenceUp, 'Вверх · эталон', '#c532b4']]) {
        if (!up) continue;
        const end = rotate(up, rotation);
        output.push({type:'scatter3d', mode:'lines', x:[0,end[0]], y:[0,end[1]], z:[0,end[2]],
          name:label, hoverinfo:'name', showlegend:false, line:{color, width:6}});
      }
    }
    return output;
  }

  function updateSelection(groups) {
    for (const card of get('photos').querySelectorAll('.photo')) {
      const id = card.dataset.id, selected = state.selected.has(id), group = groups.membership.get(id);
      card.classList.toggle('selected', selected);
      card.querySelector('.photo-toggle').setAttribute('aria-pressed', selected);
      card.style.setProperty('--group-colour', palette[(group || 0) % palette.length]);
      const hiddenExtra = state.room && !get('room-extra').checked && !roomParts()[0]?.ids.includes(id);
      card.querySelector('.badge').textContent = hiddenExtra ? 'Скрыто: нет совмещения' : selected ? (state.variant.edges === null ? 'Показано' : `Подгруппа ${(group || 0) + 1}`) : 'Скрыто';
    }
    const split = [...groups.counts.values()].some(n => n > 1);
    get('selection-status').classList.toggle('split', split);
    let text = `Выбрано ${state.selected.size} из ${state.room ? roomNames().length : state.variant.sources.length}`;
    if (state.room) text += ' в предполагаемой комнате' + (!roomNames().length ? ' · камер не назначено' : roomParts().length > 1 ? ' · размещение частей условное' : ' · одна геометрическая часть');
    if (split) text += ` · подгрупп среди выбранных фото: ${groups.total}`;
    if (settings.multiview) text += ' · позы полной группы сохранены';
    get('selection-status').textContent = text + '.';
    const shown = state.room && !get('room-extra').checked ? new Set(roomParts()[0]?.ids || []) : state.selected;
    const selected = state.variant.sources.filter(s => state.selected.has(s.id) && shown.has(s.id));
    const count = selected.reduce((n, s) => n + Math.min(state.limit, s.available), 0);
    const patches = selected.reduce((n, s) => n + (s.planes?.count || 0), 0);
    const faces = selected.reduce((n, s) => n + (s.planes?.triangles || 0), 0);
    const coverage = selected.filter(s => s.planes).map(s => 100 * s.planes.coverage);
    get('counts').textContent = [state.mode !== 'planes' ? `${count.toLocaleString('ru')} точек` : '',
      state.mode !== 'points' ? `${patches} участков · ${faces.toLocaleString('ru')} треугольников` : '',
      state.mode !== 'points' && coverage.length ? `покрытие фото: ${Math.min(...coverage).toFixed(0)}–${Math.max(...coverage).toFixed(0)}%` : ''].filter(Boolean).join(' · ');
    get('detail-control').querySelector('.segments').hidden = state.mode === 'planes';
    get('detail-control').firstElementChild.hidden = state.mode === 'planes';
    get('plane-note').hidden = state.mode === 'points';
    for (const group of get('photos').querySelectorAll('.photo-group')) {
      const button = group.querySelector('.group-only');
      if (!button) continue;
      const ids = state.variant.components.find(c => c.id === group.dataset.component).ids.filter(id => !state.room || roomNames().includes(id));
      button.setAttribute('aria-pressed', ids.length === state.selected.size && ids.every(id => state.selected.has(id)));
    }
  }

  async function draw() {
    ++state.version; // Invalidate an in-flight draw as soon as controls change.
    if (drawing) return;
    drawing = true;
    try {
      let version;
      do {
        version = state.version;
        await drawVersion(version);
      } while (version !== state.version);
    } finally { drawing = false; }
  }

  async function drawVersion(version) {
    const started = performance.now();
    const groups = selectionGroups();
    updateSelection(groups);
    get('top').textContent = get('level').checked && state.variant.components.every(c => c.levelled) ? 'Вид сверху' : 'Вдоль −y камеры';
    get('loading').textContent = 'Подготовка 3D…';
    try {
      if (state.room) await drawRoom(version, groups);
      else for (const component of state.variant.components) {
        const view = plots.get(component.id), visible = component.ids.some(id => state.selected.has(id));
        view.section.hidden = !visible;
        // Many SIFT components can be isolated. Only nearby plots keep WebGL contexts.
        if (!visible || !view.nearby) { release(view); continue; }
        const data = await traces(component, groups);
        if (version !== state.version) return;
        const level = get('level').checked && component.levelled;
        const ranges = level ? component.ranges : component.rawRanges;
        const labels = level ? ['x, м', 'y, м', 'z вверх, м'] : ['x камеры, м', 'z камеры, м', '−y камеры, м'];
        const camera = currentCamera(view.plot) || cameras.get(view.key) || defaultCamera;
        const scene = {aspectmode: 'manual', aspectratio: fixedAspect(ranges), camera};
        ['xaxis', 'yaxis', 'zaxis'].forEach((axis, i) => { scene[axis] = {title: {text: labels[i], font: {size: 12}}, tickfont: {size: 10}, range: ranges[i].slice(), autorange: false}; });
        view.rendering = true;
        try {
          await Plotly.react(view.plot, data, {scene, margin: {l: 0, r: 0, b: 0, t: 0}, uirevision: 'fixed-camera', paper_bgcolor: '#fff'},
            {displayModeBar: false, scrollZoom: true, responsive: true, plotGlPixelRatio: 1});
        } finally {
          view.rendering = false;
          if (view.disposed) release(view);
        }
        if (version !== state.version) return;
      }
      if (version === state.version) get('loading').textContent = state.selected.size ? '' : 'Выберите фотографии ниже.';
      if (diagnostics && version === state.version) console.info('planrec-viewer ' + JSON.stringify({
        selected: state.selected.size, mode: state.mode, limit: state.limit,
        updateMs: Math.round(performance.now() - started), readySinceNavigationMs: Math.round(performance.now()),
        geometryBytesRequested: loadedBytes, geometryFilesRequested: assets.size,
      }));
    } catch (error) {
      if (version === state.version) get('loading').textContent = 'Не удалось загрузить 3D. Можно повторить выбор уровня детализации. ' + error.message;
    }
  }

  function build() {
    updateRoomControls();
    collapseScene();
    observer?.disconnect();
    for (const view of plots.values()) release(view);
    plots.clear(); geometry.clear(); get('scenes').replaceChildren(); get('photos').replaceChildren();
    observer = new IntersectionObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const view = plots.get(entry.target.dataset.component);
        const nearby = expanded?.view === view || entry.isIntersecting;
        if (view && view.nearby !== nearby) { view.nearby = nearby; changed = true; }
      }
      if (changed) scheduleDraw();
    }, {rootMargin: '120px'});
    const sorted = state.room ? roomParts().map(p => ({...p.component, ids: p.ids}))
      : [...state.variant.components].sort((a, b) => b.ids.length - a.ids.length);
    if (state.room) buildRoomScene();
    const photoSources = sorted.flatMap(c => state.variant.sources.filter(s => c.ids.includes(s.id) && s.photo));
    const photoItems = photoSources.map(s => ({src: s.photo, caption: s.name, href: s.href}));
    const isolated = sorted.filter(c => c.ids.length === 1).length;
    let isolatedGrid;
    for (let index = 0; index < sorted.length; index++) {
      const component = sorted[index], section = document.createElement('section'), header = document.createElement('header'), plot = document.createElement('div');
      section.className = 'scene' + (index ? ' secondary' : ''); plot.className = 'plot';
      const title = document.createElement('h2'); title.textContent = `Группа ${Number(component.id) + 1} · ${settings.multiview ? 'фото' : 'источники'}: ${component.ids.length}`;
      const heading = document.createElement('div'); heading.className = 'scene-heading';
      const expand = document.createElement('button'); expand.className = 'scene-expand';
      expand.textContent = '⤢'; expand.title = 'Развернуть 3D';
      expand.setAttribute('aria-label', 'Развернуть 3D'); expand.setAttribute('aria-haspopup', 'dialog');
      expand.setAttribute('aria-expanded', 'false'); heading.append(title, expand); header.append(heading);
      if (index) { const note = document.createElement('p'); note.textContent = 'Отдельная система координат · положение относительно других групп неизвестно'; header.append(note); }
      if (component.warnings) {
        const warning = document.createElement('p'); warning.className = 'warning';
        warning.textContent = `Расхождения путей: ${component.warnings}${component.cycleChecks == null ? '' : ' из ' + component.cycleChecks}. Совместное уточнение поз не выполнено.`;
        header.append(warning);
      } else if (settings.multiview && component.cycleChecks === 0) {
        const note = document.createElement('p'); note.textContent = 'Замкнутых путей нет: альтернативная проверка размещения недоступна.'; header.append(note);
      }
      for (const note of component.notes || []) {
        const row = document.createElement('p'), link = document.createElement('a'); row.className = 'warning';
        link.href = note.href; link.textContent = note.text; row.append(link); header.append(row);
      }
      if (!state.room) {
        section.append(header, plot); get('scenes').append(section);
        enableNavigation(plot);
        plot.dataset.component = component.id;
        const view = {section, plot, key: `${state.variant.id}:${component.id}`, nearby: index === 0};
        plots.set(component.id, view);
        expand.onclick = () => expandScene(view, expand);
        observer.observe(plot);
      }
      const singleton = !state.room && component.ids.length === 1 && isolated > 1;
      let grid = singleton ? isolatedGrid : null;
      if (!grid) {
        const group = document.createElement('div'); group.className = 'photo-group'; group.dataset.component = component.id;
        const heading = document.createElement('div'); heading.className = 'group-heading';
        const label = document.createElement('span');
        label.textContent = state.room ? `Часть ${index + 1} · ${component.ids.length} фото` + (sorted.length > 1 ? ' · положение относительно других частей неизвестно' : ' · позы по выбранному графу')
          : singleton ? `Без принятых связей · фото: ${isolated} · каждое показано отдельно` : title.textContent + (index ? ' · нет принятой связи с основной группой' : '');
        heading.append(label);
        if (settings.multiview && !singleton) {
          const only = document.createElement('button'); only.className = 'group-only'; only.textContent = 'Только эту группу';
          only.setAttribute('aria-label', `Показать только группу ${Number(component.id) + 1}`);
          only.onclick = () => { state.selected = new Set(component.ids); draw(); };
          heading.append(only);
        }
        group.append(heading);
        grid = document.createElement('div'); grid.className = 'photo-grid'; group.append(grid);
        get('photos').append(group);
        if (singleton) isolatedGrid = grid;
      }
      for (const source of state.variant.sources.filter(s => component.ids.includes(s.id))) {
        const card = document.createElement('div'); card.className = 'photo'; card.dataset.id = source.id;
        const button = document.createElement('button'); button.className = 'photo-toggle'; button.setAttribute('aria-label', 'Показать или скрыть ' + source.name);
        if (source.photo) { const img = document.createElement('img'); img.src = source.photo; img.alt = source.name; img.loading = 'lazy'; button.append(img); }
        const name = document.createElement('span'); name.className = 'name'; name.textContent = source.name; button.append(name);
        const badge = document.createElement('span'); badge.className = 'badge'; button.append(badge);
        if (source.planes) button.title = `Плоские участки покрывают ${(source.planes.coverage * 100).toFixed(0)}% допустимых пикселей`;
        button.onclick = () => { if (!state.selected.delete(source.id)) state.selected.add(source.id); draw(); };
        card.append(button);
        const actions = document.createElement('div'); actions.className = 'photo-actions';
        if (source.photo) {
          const enlarge = document.createElement('button'); enlarge.className = 'photo-enlarge'; enlarge.textContent = '⤢';
          enlarge.title = 'Увеличить'; enlarge.setAttribute('aria-label', 'Увеличить ' + source.name);
          enlarge.onclick = () => photoViewer.open(photoItems, photoSources.indexOf(source), enlarge);
          actions.append(enlarge);
        }
        if (source.href) {
          const link = document.createElement('a'); link.href = source.href; link.textContent = 'Отчёт ↗';
          link.setAttribute('aria-label', 'Отчёт фото ' + source.name); actions.append(link);
        }
        card.append(actions);
        grid.append(card);
      }
    }
    const hasPlanes = state.variant.sources.some(s => s.planes);
    get('representation').hidden = !hasPlanes;
    if (!hasPlanes) state.mode = 'points';
    for (const button of get('representation').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', button.dataset.mode === state.mode);
    }
    get('level-label').hidden = !state.variant.components.some(c => c.levelled);
    get('paths-label').hidden = !!state.room || !state.variant.treeEdges.length;
    draw();
  }

  function currentSemantics() {
    return semanticVariants.find(v => v.id === state.roomSource)?.semantics || settings.semantics;
  }
  function roomNames() {
    return state.room === 'unassigned' ? currentSemantics().unassigned
      : currentSemantics()?.rooms.find(room => room.id === state.room)?.names || [];
  }
  function roomParts() {
    return window.planrecRoomView.parts(state.variant.components, roomNames());
  }
  function updateRoomControls() {
    const semantic = currentSemantics();
    get('rooms-control').hidden = !semantic;
    get('room-controls').hidden = !state.room;
    get('rooms').checked = !!state.room;
    get('room-warning').textContent = state.room === 'unassigned'
      ? 'Назначение комнат и взаимное положение облаков неизвестны. Размещение рядом служит только обзору.'
      : state.room && !roomNames().length
      ? 'Камеры этой комнате не назначены. Фото-свидетельства и проходы сохранены; геометрия и положение комнаты не определены.'
      : state.room && roomParts().length === 1
      ? 'Принадлежность комнате предположена. Все фото имеют связующий геометрический путь; показаны оценки поз выбранной ветви.'
      : 'Принадлежность комнате предположена. Несовмещённые части разнесены только для обзора — их взаимное положение неизвестно.';
    if (!semantic) return;
    get('room-source-control').hidden = semanticVariants.length < 2;
    options(get('room-source'), semanticVariants.map(v => [v.id, v.label]), state.roomSource);
    const choices = semantic.rooms.map((room, i) => [room.id, `${room.label || 'Гипотеза ' + (i + 1)} · ${room.names.length ? room.names.length + ' фото' : 'без назначенных камер'}`]);
    if (semantic.unassigned.length) choices.push(['unassigned', `Без назначения · ${semantic.unassigned.length} фото`]);
    options(get('room-choice'), choices, state.room || choices[0]?.[0]);
  }
  function selectRoom(id, source = state.roomSource) {
    if (state.room) roomSelections.set(`${state.variant.id}:${state.roomSource}:${state.room}`, new Set(state.selected));
    else selections.set(state.variant.id, new Set(state.selected));
    state.roomSource = source;
    state.room = id;
    state.selected = new Set(id ? roomSelections.get(`${state.variant.id}:${state.roomSource}:${id}`) || roomNames()
      : selections.get(state.variant.id) || state.variant.initial);
    updateRoomControls(); build();
  }
  function selectRoomSource(id) {
    if (state.room) sourceRooms.set(state.roomSource, state.room);
    const semantic = semanticVariants.find(v => v.id === id)?.semantics;
    if (!semantic) return;
    selectRoom(sourceRooms.get(id) || semantic.rooms[0]?.id || (semantic.unassigned.length ? 'unassigned' : null), id);
  }
  function buildRoomScene() {
    const semantic = currentSemantics(), names = roomNames(), parts = roomParts();
    const index = semantic.rooms.findIndex(room => room.id === state.room);
    const title = index < 0 ? 'Фото без назначения комнате' : semantic.rooms[index].label || `Гипотеза комнаты ${index + 1}`;
    const details = get('room-details'); details.replaceChildren();
    const status = document.createElement('p');
    const ambiguous = names.filter(n => semantic.ambiguous.includes(n));
    status.textContent = `Это гипотеза, не установленная комната. Геометрических частей: ${parts.length}. `
      + (ambiguous.length ? `Альтернативные назначения: ${ambiguous.join(', ')}. ` : '')
      + (names.length ? 'Позы внутри каждой части сохранены по выбранному графу, в том числе по путям через фото вне этой гипотезы.'
        : `Камеры не назначены. Фото-свидетельства: ${(semantic.rooms[index]?.evidence_photos || []).join(', ') || 'не указаны'}. Положение и геометрия не определены.`);
    details.append(status);
    const evidence = document.createElement('a'); evidence.href = semantic.href + '#' + state.room;
    evidence.textContent = 'Фото, основания и альтернативы ↗'; details.append(evidence);
    const doorways = semantic.doorways.filter(d => semantic.kind === 'global' ? d.room_pairs.flat().includes(state.room) : names.includes(d.a) || names.includes(d.b));
    const doorDetails = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = `Предполагаемые проходы · ${semantic.kind === 'global' ? 'гипотезы' : 'парные свидетельства'}: ${doorways.length}`; doorDetails.append(summary);
    const list = document.createElement('ul');
    for (const door of doorways) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = door.href || semantic.href.replace(/rooms\.html$/, `vlm/pair-${String(door.evidence).padStart(4, '0')}.html`);
      link.textContent = semantic.kind === 'global'
        ? door.room_pairs[0].map(id => semantic.rooms.find(r => r.id === id)?.label || 'Не назначено фото').join(' ↔ ')
        : door.label || `${door.a} ↔ ${door.b}`; item.append(link);
      item.append(document.createTextNode(door.assignment === 'global_hypothesis' ? ' · вывод по всем фото' : door.assignment === 'unique_hypotheses' ? ' · связь гипотез комнат' : ' · назначение комнат неоднозначно / неизвестно'));
      list.append(item);
    }
    doorDetails.append(list); details.append(doorDetails);
    const report = document.createElement('a'); report.href = semantic.candidateHref || semantic.href + '#candidates';
    report.textContent = semantic.candidateHref ? 'Восстановленные связи и проверки 3D ↗' : 'Новые кандидаты перекрытия и сохранённые варианты 3D ↗'; details.append(report);
    const section = document.createElement('section'); section.className = 'scene';
    const header = document.createElement('header'), heading = document.createElement('div'); heading.className = 'scene-heading';
    const h2 = document.createElement('h2'); h2.textContent = title;
    const expand = document.createElement('button'); expand.className = 'scene-expand'; expand.textContent = '⤢';
    expand.setAttribute('aria-label', 'Развернуть 3D'); expand.setAttribute('aria-haspopup', 'dialog'); expand.setAttribute('aria-expanded', 'false');
    heading.append(h2, expand); header.append(heading);
    const note = document.createElement('p'); note.className = 'warning';
    note.textContent = state.room === 'unassigned' ? 'Комнаты не определены; взаимное положение облаков неизвестно.'
      : !names.length ? 'Комната сохранена по фото-свидетельствам. Камер и восстановленной геометрии нет.'
      : parts.length === 1 ? 'Предположительно та же комната. Одна геометрическая часть; позы по выбранному графу.'
      : 'Предположительно та же комната; положение несовмещённых частей неизвестно. Раскладка для обзора, не планировка.'; header.append(note);
    const warnings = parts.reduce((n, p) => n + (p.component.warnings || 0), 0);
    if (warnings) { const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = `В исходных компонентах отмечены расхождения путей: ${warnings}. Показ комнаты не исправляет позы.`; header.append(warning); }
    const legend = document.createElement('div'); legend.className = 'room-legend';
    parts.forEach((part, i) => { const label = document.createElement('span'); label.textContent = `Часть ${i + 1}: ${part.ids.join(', ')}`; legend.append(label); });
    header.append(legend);
    if (!names.length) {
      expand.hidden = true; section.append(header); get('scenes').append(section);
      get('room-extra').disabled = true; return;
    }
    const plot = document.createElement('div'); plot.className = 'plot'; plot.dataset.component = '__room__';
    section.append(header, plot); get('scenes').append(section);
    const view = {section, plot, key: `${state.variant.id}:${state.roomSource}:${state.room}`, nearby: true}; plots.set('__room__', view);
    enableNavigation(plot); expand.onclick = () => expandScene(view, expand); observer.observe(plot);
    get('room-extra').disabled = parts.length < 2;
  }
  async function drawRoom(version, groups) {
    const view = plots.get('__room__');
    if (!view) return;
    if (!view.nearby) { release(view); return; }
    const parts = roomParts(), shown = get('room-extra').checked ? parts : parts.slice(0, 1);
    const entries = [];
    for (const part of shown) {
      if (!part.ids.some(id => state.selected.has(id))) continue;
      entries.push({label: `Часть ${parts.indexOf(part) + 1}`, data: await traces(part.component, groups)});
      if (version !== state.version) return;
    }
    const layout = window.planrecRoomView.layout(entries);
    const scene = {aspectmode: 'manual', aspectratio: fixedAspect(layout.ranges),
      camera: currentCamera(view.plot) || cameras.get(view.key) || roomCamera};
    ['xaxis', 'yaxis', 'zaxis'].forEach((axis, i) => { scene[axis] = {visible: false, range: layout.ranges[i], autorange: false}; });
    view.rendering = true;
    try {
      await Plotly.react(view.plot, layout.data, {scene, margin: {l: 0, r: 0, b: 0, t: 0}, uirevision: view.key, paper_bgcolor: '#fff'},
        {displayModeBar: false, scrollZoom: true, responsive: true, plotGlPixelRatio: 1});
    } finally { view.rendering = false; if (view.disposed) release(view); }
  }

  function options(select, items, current) {
    select.replaceChildren();
    for (const [id, label] of items) {
      const option = document.createElement('option'); option.value = id; option.textContent = label; select.append(option);
    }
    select.value = current;
  }
  const matchers = new Map(settings.variants.filter(v => v.matcher).map(v => [v.matcher, v.matcherLabel]));
  function updateControls() {
    get('matcher-control').hidden = matchers.size < 2;
    options(get('matcher'), matchers, state.variant.matcher);
    const choices = settings.variants.filter(v => v.matcher === state.variant.matcher);
    const models = new Map(choices.map(v => [v.model, v.label]));
    options(get('model'), models, state.variant.model);
    get('model-control').hidden = models.size < 2;
    get('model-label').textContent = matchers.size ? 'Глубина' : 'Модель';
    const reviewed = choices.find(v => v.model === state.variant.model && v.vlm && !v.recovery);
    const recovered = choices.find(v => v.model === state.variant.model && v.recovery);
    get('recovery-control').hidden = !recovered;
    get('recovery').disabled = !recovered || !state.variant.vlm;
    get('recovery').checked = !!state.variant.recovery;
    const recoveryStatus = get('recovery-status'); recoveryStatus.replaceChildren();
    recoveryStatus.hidden = !state.variant.recovery;
    if (state.variant.recovery) {
      const result = recovered.recoveryInfo;
      recoveryStatus.append(document.createTextNode(`Восстановлено мостов: ${result.bridges}; дополнительных ограничений: ${result.constraints}; всего связей: ${result.edges}. Масштаб задан опорной компонентой; внутренние позы сохранены. `));
      const link = document.createElement('a'); link.href = result.href; link.textContent = 'Проверки и поправки масштаба ↗'; recoveryStatus.append(link);
    }
    const visible = settings.multiview && !!state.variant.matcher;
    get('vlm-control').hidden = !visible;
    get('vlm-status').hidden = !visible;
    get('vlm').disabled = !reviewed;
    get('vlm').checked = !!state.variant.vlm;
    const status = get('vlm-status'); status.replaceChildren();
    if (reviewed) {
      const result = reviewed.review;
      status.append(document.createTextNode(state.variant.vlm
        ? `Эксперимент VLM: удалено связей ${result.removed}; сохранено ${result.kept}, из них не подтверждено VLM ${result.unresolved}. `
        : 'Исходная геометрия. Сохранённый эксперимент VLM доступен. '));
      status.append(document.createTextNode(`Проверено пар: ${result.checkedPairs}/${result.possiblePairs}. `));
      const link = document.createElement('a'); link.href = result.href;
      link.textContent = 'Решения и основания ↗'; status.append(link);
    } else {
      status.textContent = 'Для этого сочетания сохранённая проверка VLM отсутствует.';
    }
  }
  function chooseVariant(next) {
    if (!next || next.id === state.variant.id) return;
    if (state.room) roomSelections.set(`${state.variant.id}:${state.roomSource}:${state.room}`, new Set(state.selected));
    else selections.set(state.variant.id, new Set(state.selected));
    const sameInputs = next.matcher === state.variant.matcher && next.model === state.variant.model;
    const selection = state.room ? roomSelections.get(`${next.id}:${state.roomSource}:${state.room}`) || state.selected
      : selections.get(next.id) || (sameInputs ? state.selected : next.initial);
    state.variant = next;
    state.selected = new Set(selection);
    updateControls(); build();
  }
  function variantFor(matcher, model, vlm, recovery = false) {
    const choices = settings.variants.filter(v => v.matcher === matcher && v.model === model);
    return choices.find(v => !!v.vlm === !!vlm && !!v.recovery === !!recovery)
      || choices.find(v => !!v.vlm === !!vlm && !v.recovery) || choices.find(v => !v.vlm)
      || settings.variants.find(v => v.matcher === matcher && !v.vlm);
  }
  get('matcher').onchange = () => chooseVariant(variantFor(get('matcher').value, state.variant.model, state.variant.vlm, state.variant.recovery));
  get('model').onchange = () => chooseVariant(variantFor(state.variant.matcher, get('model').value, state.variant.vlm, state.variant.recovery));
  get('vlm').onchange = () => chooseVariant(variantFor(state.variant.matcher, state.variant.model, get('vlm').checked));
  get('recovery').onchange = () => chooseVariant(variantFor(state.variant.matcher, state.variant.model, true, get('recovery').checked));
  const params = new URLSearchParams(location.search);
  if (params.has('model') || params.has('recovery')) state.variant = variantFor(params.get('matcher') || state.variant.matcher, params.get('model') || state.variant.model, params.get('recovery') === '1', params.get('recovery') === '1') || state.variant;
  updateControls();
  get('all').onclick = () => { state.selected = new Set(state.room ? roomNames() : state.variant.sources.filter(s => !s.reference).map(s => s.id)); draw(); };
  get('none').onclick = () => { state.selected.clear(); draw(); };
  for (const button of get('detail').querySelectorAll('button')) button.onclick = () => {
    state.limit = Number(button.dataset.limit);
    for (const other of get('detail').querySelectorAll('button')) other.setAttribute('aria-pressed', other === button);
    draw();
  };
  for (const button of get('representation').querySelectorAll('button')) button.onclick = () => {
    state.mode = button.dataset.mode;
    for (const other of get('representation').querySelectorAll('button')) other.setAttribute('aria-pressed', other === button);
    draw();
  };
  for (const id of ['colour', 'cameras', 'level', 'paths']) get(id).onchange = draw;
  get('reset').onclick = () => { for (const view of plots.values()) if (view.plot.data) Plotly.relayout(view.plot, {'scene.camera': state.room ? roomCamera : defaultCamera}); };
  get('top').onclick = () => { for (const view of plots.values()) if (view.plot.data) Plotly.relayout(view.plot, {'scene.camera': {eye: {x: 0, y: 0, z: 2.3}, up: {x: 0, y: 1, z: 0}, center: {x: 0, y: 0, z: 0}}}); };
  get('rooms').onchange = () => selectRoom(get('rooms').checked ? get('room-choice').value : null);
  get('room-choice').onchange = () => selectRoom(get('room-choice').value);
  get('room-source').onchange = () => selectRoomSource(get('room-source').value);
  get('room-extra').onchange = draw;
  const requestedRoom = params.get('room');
  const requestedSource = semanticVariants.find(v => v.semantics.rooms.some(r => r.id === requestedRoom));
  if (requestedSource) { state.roomSource = requestedSource.id; state.room = requestedRoom; }
  else if (settings.semantics && requestedRoom === 'unassigned' && settings.semantics.unassigned.length) state.room = requestedRoom;
  state.selected = new Set(state.room ? roomNames() : state.variant.initial); updateRoomControls(); build();
})();

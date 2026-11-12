/* Static scene viewer. Geometry is immutable; selection changes visibility only. */
(() => {
  'use strict';
  const settings = JSON.parse(document.getElementById('scene-data').textContent);
  const get = id => document.getElementById(id);
  const photoViewer = window.planrecPhotoViewer();
  const palette = ['#168575', '#ce621c', '#6551c5', '#bd3c8a', '#267bb7', '#7c4f37', '#85801d'];
  const defaultCamera = {eye: {x: 1.35, y: -1.8, z: .8}, up: {x: 0, y: 0, z: 1}, center: {x: 0, y: 0, z: 0}};
  const state = {variant: settings.variants[0], selected: new Set(), limit: settings.defaultLimit, mode: 'points', version: 0};
  const assets = new Map(), geometry = new Map(), plots = new Map(), cameras = new Map(), selections = new Map();
  let observer, expanded, scheduled = false;
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
        script.onload = () => {
          const raw = window.planrecData[asset.key];
          const data = {xyz: decode(raw.xyz, Float32Array), rgb: decode(raw.rgb, Uint8Array)};
          if (raw.triangles) data.triangles = decode(raw.triangles, Uint32Array);
          if (raw.patch) data.patch = decode(raw.patch, Uint16Array);
          delete window.planrecData[asset.key]; // Do not retain duplicate base64 strings.
          script.remove();
          resolve(data);
        };
        script.onerror = () => { assets.delete(asset.key); script.remove(); reject(new Error(asset.url)); };
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
    if (get('paths').checked) {
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
    if (get('cameras').checked) {
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
      card.querySelector('.badge').textContent = selected ? (state.variant.edges === null ? 'Показано' : `Подгруппа ${(group || 0) + 1}`) : 'Скрыто';
    }
    const split = [...groups.counts.values()].some(n => n > 1);
    get('selection-status').classList.toggle('split', split);
    let text = `Выбрано ${state.selected.size} из ${state.variant.sources.length}`;
    if (split) text += ` · подгрупп среди выбранных фото: ${groups.total}`;
    if (settings.multiview) text += ' · позы полной группы сохранены';
    get('selection-status').textContent = text + '.';
    const selected = state.variant.sources.filter(s => state.selected.has(s.id));
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
      const ids = state.variant.components.find(c => c.id === group.dataset.component).ids;
      button.setAttribute('aria-pressed', ids.length === state.selected.size && ids.every(id => state.selected.has(id)));
    }
  }

  async function draw() {
    const started = performance.now();
    const version = ++state.version, groups = selectionGroups();
    updateSelection(groups);
    get('top').textContent = get('level').checked && state.variant.components.every(c => c.levelled) ? 'Вид сверху' : 'Вдоль −y камеры';
    get('loading').textContent = 'Подготовка 3D…';
    try {
      for (const component of state.variant.components) {
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
        await Plotly.react(view.plot, data, {scene, margin: {l: 0, r: 0, b: 0, t: 0}, uirevision: 'fixed-camera', paper_bgcolor: '#fff'},
          {displayModeBar: false, scrollZoom: true, responsive: true, plotGlPixelRatio: 1});
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
    const sorted = [...state.variant.components].sort((a, b) => b.ids.length - a.ids.length);
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
      section.append(header, plot); get('scenes').append(section);
      enableNavigation(plot);
      plot.dataset.component = component.id;
      const view = {section, plot, key: `${state.variant.id}:${component.id}`, nearby: index === 0};
      plots.set(component.id, view);
      expand.onclick = () => expandScene(view, expand);
      observer.observe(plot);
      const singleton = component.ids.length === 1 && isolated > 1;
      let grid = singleton ? isolatedGrid : null;
      if (!grid) {
        const group = document.createElement('div'); group.className = 'photo-group'; group.dataset.component = component.id;
        const heading = document.createElement('div'); heading.className = 'group-heading';
        const label = document.createElement('span');
        label.textContent = singleton ? `Без принятых связей · фото: ${isolated} · каждое показано отдельно` : title.textContent + (index ? ' · нет принятой связи с основной группой' : '');
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
    get('level-label').hidden = !state.variant.components.some(c => c.levelled);
    get('paths-label').hidden = !state.variant.treeEdges.length;
    draw();
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
    options(get('model'), new Map(choices.map(v => [v.model, v.label])), state.variant.model);
    get('model-control').hidden = choices.length < 2;
    get('model-label').textContent = matchers.size ? 'Глубина' : 'Модель';
  }
  function chooseVariant(next) {
    if (!next || next.id === state.variant.id) return;
    selections.set(state.variant.id, new Set(state.selected));
    state.variant = next;
    state.selected = new Set(selections.get(next.id) || next.initial);
    updateControls(); build();
  }
  get('matcher').onchange = () => chooseVariant(
    settings.variants.find(v => v.matcher === get('matcher').value && v.model === state.variant.model)
    || settings.variants.find(v => v.matcher === get('matcher').value));
  get('model').onchange = () => chooseVariant(settings.variants.find(v => v.matcher === state.variant.matcher && v.model === get('model').value));
  updateControls();
  get('all').onclick = () => { state.selected = new Set(state.variant.sources.filter(s => !s.reference).map(s => s.id)); draw(); };
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
  get('reset').onclick = () => { for (const view of plots.values()) if (view.plot.data) Plotly.relayout(view.plot, {'scene.camera': defaultCamera}); };
  get('top').onclick = () => { for (const view of plots.values()) if (view.plot.data) Plotly.relayout(view.plot, {'scene.camera': {eye: {x: 0, y: 0, z: 2.3}, up: {x: 0, y: 1, z: 0}, center: {x: 0, y: 0, z: 0}}}); };
  state.selected = new Set(state.variant.initial); build();
})();

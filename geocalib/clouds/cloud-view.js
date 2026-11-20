/* Static scene viewer. Geometry is immutable; selection changes visibility only. */
(async () => {
  'use strict';
  const settings = JSON.parse(document.getElementById('scene-data').textContent);
  const renderer = await import('./three-renderer.js');
  const {decodePoints, transformedBounds} = await import('./cloud-buffers.js');
  const tools = await import('./viewer-tools.js');
  const coordinateUnit = settings.relativeScale ? 'rel. units' : 'm';
  const get = id => document.getElementById(id);
  const photoViewer = window.planrecPhotoViewer();
  const palette = ['#168575', '#ce621c', '#6551c5', '#bd3c8a', '#267bb7', '#7c4f37', '#85801d'];
  const defaultCamera = {eye: {x: 1.35, y: -1.8, z: .8}, up: {x: 0, y: 0, z: 1}, center: {x: 0, y: 0, z: 0}, fit: true};
  const roomCamera = {eye: {x: 0, y: -2.1, z: 1}, up: {x: 0, y: 0, z: 1}, center: {x: 0, y: 0, z: 0}, fit: true};
  const preferred = settings.variants.find(v => v.id === settings.defaultVariant) || settings.variants[0];
  const state = {variant: preferred, selected: new Set(), limit: settings.defaultLimit ?? 100000, mode: 'points', version: 0, room: null, roomSource: 'pairwise'};
  const semanticVariants = [{id: 'pairwise', label: 'Pairwise hypotheses', semantics: settings.semantics}, ...(settings.roomVariants || [])].filter(v => v.semantics);
  const sourceRooms = new Map();
  const assets = new Map(), geometry = new Map(), plots = new Map(), cameras = new Map(), selections = new Map();
  const roomSelections = new Map(), inspections = new Map();
  let observer, expanded, scheduled = false, drawing = false;
  const sceneDialog = document.createElement('dialog');
  sceneDialog.className = 'scene-viewer';
  sceneDialog.setAttribute('aria-label', 'Expanded 3D view');
  document.body.append(sceneDialog);
  sceneDialog.addEventListener('close', () => { if (!sceneDialog.open) collapseScene(); });
  function scheduleDraw() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; draw(); });
    }
  }
  function release(view) {
    // A variant can disappear while renderer.react is still using its DOM node.
    if (view.rendering) { view.disposed = true; return; }
    if (view.plot.data) {
      if (!view.discardState) { cameras.set(view.key, currentCamera(view.plot)); inspections.set(view.key, renderer.inspectionState(view.plot)); }
      renderer.purge(view.plot); view.needsInspection = true;
    }
  }
  const diagnostics = new URLSearchParams(location.search).has('qa');
  if (diagnostics) document.documentElement.classList.add('viewer-benchmark');
  let loadedBytes = 0, pointCacheBytes = 0;
  const pointCacheSizes = new Map();
  const decode = (value, Type) => new Type(Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer);
  const rotate = (p, r) => r.map(row => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
  const pose = (p, m) => m.slice(0, 3).map(row => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]);
  const position = (p, source, component) => rotate(pose(p, source.pose), get('level').checked ? component.rotation : component.fixed);
  const sourceColour = source => palette[state.variant.sources.indexOf(source) % palette.length];

  function currentCamera(plot) { return renderer.currentCamera(plot); }

  function fixedAspect(ranges) {
    const spans = ranges.map(([lo, hi]) => Math.max(hi - lo, 1e-9));
    const unit = Math.cbrt(spans[0] * spans[1] * spans[2]);
    return Object.fromEntries(['x', 'y', 'z'].map((axis, i) => [axis, spans[i] / unit]));
  }

  function resizeScene(view) {
    requestAnimationFrame(() => {
      if (!view.plot.isConnected || !view.plot.data) return;
      renderer.Plots.resize(view.plot);
    });
  }

  function collapseScene() {
    if (!expanded) return;
    const {view, placeholder, button, tools, scroll} = expanded;
    expanded = null;
    if (sceneDialog.open) sceneDialog.close();
    placeholder.replaceWith(view.section);
    for (const [slot, control] of tools) slot.replaceWith(control);
    document.body.classList.remove('scene-viewer-open');
    button.textContent = '⤢'; button.title = 'Expand 3D';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Expand 3D');
    button.focus({preventScroll: true});
    window.scrollTo(scroll.x, scroll.y);
    resizeScene(view);
  }

  function expandScene(view, button) {
    if (expanded) { collapseScene(); return; }
    const scroll = {x: window.scrollX, y: window.scrollY};
    const placeholder = document.createElement('div');
    placeholder.className = 'scene-placeholder';
    placeholder.style.height = view.section.getBoundingClientRect().height + 'px';
    view.section.before(placeholder);
    const tools = ['detail-control', 'view-controls', 'render-diagnostics'].map(id => {
      const control = get(id), slot = document.createElement('span');
      control.before(slot);
      (id === 'render-diagnostics' ? view.section : view.section.querySelector('header')).append(control);
      return [slot, control];
    });
    expanded = {view, placeholder, button, tools, scroll}; view.nearby = true;
    sceneDialog.append(view.section);
    document.body.classList.add('scene-viewer-open');
    button.textContent = '⤡'; button.title = 'Collapse 3D (Esc)';
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-label', 'Collapse 3D');
    sceneDialog.showModal();
    button.focus({preventScroll: true});
    resizeScene(view);
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

  async function loadDense(asset) {
    if (!assets.has(asset.key)) {
      loadedBytes += asset.bytes;
      const pending = fetch(asset.url).then(async response => {
        if (!response.ok) throw new Error(`Point buffer ${response.status}: ${asset.url}`);
        const decoded = decodePoints(await response.arrayBuffer(), asset.end - asset.start);
        pointCacheSizes.set(asset.key, asset.bytes); pointCacheBytes += asset.bytes;
        while (pointCacheBytes > 256 * 1024 * 1024 && pointCacheSizes.size > 1) {
          const [key, bytes] = pointCacheSizes.entries().next().value;
          pointCacheBytes -= bytes; pointCacheSizes.delete(key); assets.delete(key);
        }
        return {...decoded, key: asset.key, start: asset.start};
      }).catch(error => { assets.delete(asset.key); throw error; });
      assets.set(asset.key, pending);
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

  async function preparedPlanes(source, component) {
    const key = `${state.variant.id}:${source.id}:planes`;
    const signature = String(get('level').checked);
    const prior = geometry.get(key);
    if (prior?.signature === signature) return prior.data;
    const rotation = get('level').checked ? component.rotation : component.fixed;
    const chunks = [source.planes];
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
    {
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
      cameraPhoto: source.photo ? {id: source.id, name: source.name} : null,
      name: `${ghost ? 'Hidden photo' : 'Camera'}: ${source.name}`, showlegend: false, hoverinfo: 'name',
      opacity: ghost ? .3 : 1, line: {width: ghost ? 2 : 4, color: ghost ? '#89958c' : palette[(groups.membership.get(source.id) || 0) % palette.length]}};
  }

  async function traces(component, groups) {
    const sources = state.variant.sources.filter(s => component.ids.includes(s.id));
    const selected = sources.filter(s => state.selected.has(s.id));
    const output = (await Promise.all(selected.map(async source => {
      const list = [], hover = `x: %{x:.2f} ${coordinateUnit}<br>y: %{y:.2f} ${coordinateUnit}<br>z: %{z:.2f} ${coordinateUnit}<extra>${source.name}</extra>`;
      if (state.mode !== 'planes') {
        const limit = state.limit || Infinity;
        const chunks = await Promise.all(source.chunks.filter(c => c.start < limit).map(loadDense));
        const rotation = get('level').checked ? component.rotation : component.fixed;
        const cloud = {id: source.id, chunks, pose: source.pose, rotation, limit, frame: component.id, unitLabel: coordinateUnit};
        list.push({type: 'scatter3d', mode: 'markers', name: source.name, cloud,
          bounds: transformedBounds(source.bounds, source.pose, rotation),
          marker: {color: get('colour').value === 'rgb' ? 'photo' : colour(source, groups, {}, 'points')},
          showlegend: false, hovertemplate: hover});
      }
      if (state.mode !== 'points' && source.planes?.triangles) {
        const data = await preparedPlanes(source, component), colors = colour(source, groups, data, 'planes');
        list.push({type: 'mesh3d', name: source.name, x: data.x, y: data.y, z: data.z, i: data.i, j: data.j, k: data.k,
          surface: {id: source.id, frame: component.id, unitLabel: coordinateUnit, pose: source.pose,
            rotation: get('level').checked ? component.rotation : component.fixed},
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
        line: {color: '#89958c', width: 3, dash: 'dash'}, name: 'Path through hidden photos', hoverinfo: 'name', showlegend: false});
      for (const id of hidden) output.push(cameraTrace(byId.get(id), component, groups, true));
    }
    if (get('cameras').checked && !state.room) {
      const rotation = get('level').checked ? component.rotation : component.fixed;
      for (const [up, label, color] of [[component.up, 'Up · GeoCalib', '#168575'], [settings.referenceUp, 'Up · reference', '#c532b4']]) {
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
      card.querySelector('.badge').textContent = hiddenExtra ? 'Hidden: unaligned' : selected ? (state.variant.edges === null ? 'Visible' : `Subgroup ${(group || 0) + 1}`) : 'Hidden';
    }
    const split = [...groups.counts.values()].some(n => n > 1);
    get('selection-status').classList.toggle('split', split);
    let text = `Selected ${state.selected.size} of ${state.room ? roomNames().length : state.variant.sources.length}`;
    if (state.room) text += ' in the hypothesized room' + (!roomNames().length ? ' · no assigned cameras' : roomParts().length > 1 ? ' · parts arranged for inspection' : ' · one geometric part');
    if (split) text += ` · visible subgroups: ${groups.total}`;
    if (settings.multiview) text += ' · full-group poses retained';
    get('selection-status').textContent = text + '.';
    const shown = state.room && !get('room-extra').checked ? new Set(roomParts()[0]?.ids || []) : state.selected;
    const selected = state.variant.sources.filter(s => state.selected.has(s.id) && shown.has(s.id));
    const count = selected.reduce((n, s) => n + Math.min(state.limit || Infinity, s.available), 0);
    const patches = selected.reduce((n, s) => n + (s.planes?.count || 0), 0);
    const faces = selected.reduce((n, s) => n + (s.planes?.triangles || 0), 0);
    const coverage = selected.filter(s => s.planes).map(s => 100 * s.planes.coverage);
    get('counts').textContent = [state.mode !== 'planes' ? `${count.toLocaleString('en')} points` : '',
      state.mode !== 'points' ? `${patches} patches · ${faces.toLocaleString('en')} triangles` : '',
      state.mode !== 'points' && coverage.length ? `photo coverage: ${Math.min(...coverage).toFixed(0)}–${Math.max(...coverage).toFixed(0)}%` : ''].filter(Boolean).join(' · ');
    get('detail').hidden = state.mode === 'planes';
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
    get('top').title = get('level').checked && state.variant.components.every(c => c.levelled) ? 'Along estimated vertical' : 'Along displayed Z (camera −y); physical vertical unknown';
    get('loading').textContent = 'Preparing 3D…';
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
        const labels = (level ? ['x', 'y', 'z up'] : ['camera x', 'camera z', 'camera -y']).map(axis => axis + ', ' + coordinateUnit);
        const camera = currentCamera(view.plot) || cameras.get(view.key) || defaultCamera;
        const scene = {aspectmode: 'manual', aspectratio: fixedAspect(ranges), camera};
        ['xaxis', 'yaxis', 'zaxis'].forEach((axis, i) => { scene[axis] = {title: {text: labels[i], font: {size: 12}}, tickfont: {size: 10}, range: ranges[i].slice(), autorange: false}; });
        view.rendering = true;
        try {
          await renderer.react(view.plot, data, {scene});
          restoreAnnotations(view);
        } finally {
          view.rendering = false;
          if (view.disposed) release(view);
        }
        if (version !== state.version) return;
      }
      if (version === state.version) get('loading').textContent = state.selected.size ? '' : 'Select photos below.';
      if (version === state.version) get('render-stats').textContent = `Ready in ${Math.round(performance.now() - started)} ms · ${(loadedBytes / 1e6).toFixed(1)} MB requested this session`;
      if (diagnostics && version === state.version) console.info('planrec-viewer ' + JSON.stringify({
        selected: state.selected.size, mode: state.mode, limit: state.limit,
        updateMs: Math.round(performance.now() - started), readySinceNavigationMs: Math.round(performance.now()),
        geometryBytesRequested: loadedBytes, geometryFilesRequested: assets.size,
      }));
    } catch (error) {
      if (version === state.version) get('loading').textContent = 'Failed to load 3D. Select a detail level to retry. ' + error.message;
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
      const title = document.createElement('h2'); title.textContent = `Group ${Number(component.id) + 1} · ${settings.multiview ? 'photos' : 'sources'}: ${component.ids.length}`;
      const heading = document.createElement('div'); heading.className = 'scene-heading';
      const expand = document.createElement('button'); expand.className = 'scene-expand';
      expand.textContent = '⤢'; expand.title = 'Expand 3D';
      expand.setAttribute('aria-label', 'Expand 3D'); expand.setAttribute('aria-haspopup', 'dialog');
      expand.setAttribute('aria-expanded', 'false'); heading.append(title, expand); header.append(heading);
      if (index) { const note = document.createElement('p'); note.textContent = 'Separate coordinate frame · placement relative to other groups is unknown'; header.append(note); }
      if (component.warnings) {
        const warning = document.createElement('p'); warning.className = 'warning';
        warning.textContent = `Path conflicts: ${component.warnings}${component.cycleChecks == null ? '' : ' of ' + component.cycleChecks}. Joint pose refinement has not been performed.`;
        header.append(warning);
      } else if (settings.multiview && component.cycleChecks === 0) {
        const note = document.createElement('p'); note.textContent = 'No cycles: no alternative path check is available.'; header.append(note);
      }
      for (const note of component.notes || []) {
        const row = document.createElement('p'), link = document.createElement('a'); row.className = 'warning';
        link.href = note.href; link.textContent = note.text; row.append(link); header.append(row);
      }
      if (!state.room) {
        section.append(header, plot); get('scenes').append(section);
        plot.dataset.component = component.id;
        const view = {section, plot, key: `${state.variant.id}:${component.id}`, nearby: index === 0, needsInspection:true};
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
        label.textContent = state.room ? `Part ${index + 1} · ${component.ids.length} photos` + (sorted.length > 1 ? ' · placement relative to other parts is unknown' : ' · poses from the selected graph')
          : singleton ? `No accepted connections · photos: ${isolated} · each shown separately` : title.textContent + (index ? ' · no accepted connection to the main group' : '');
        heading.append(label);
        if (settings.multiview && !singleton) {
          const only = document.createElement('button'); only.className = 'group-only'; only.textContent = 'Only this group';
          only.setAttribute('aria-label', `Show only group ${Number(component.id) + 1}`);
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
        const button = document.createElement('button'); button.className = 'photo-toggle'; button.setAttribute('aria-label', 'Show or hide ' + source.name);
        if (source.photo) { const img = document.createElement('img'); img.src = source.photo; img.alt = source.name; img.loading = 'lazy'; button.append(img); }
        const name = document.createElement('span'); name.className = 'name'; name.textContent = source.name; button.append(name);
        const badge = document.createElement('span'); badge.className = 'badge'; button.append(badge);
        if (source.planes) button.title = `Planar patches cover ${(source.planes.coverage * 100).toFixed(0)}% valid pixels`;
        button.onclick = () => { if (!state.selected.delete(source.id)) state.selected.add(source.id); draw(); };
        card.append(button);
        const actions = document.createElement('div'); actions.className = 'photo-actions';
        if (source.photo) {
          const enlarge = document.createElement('button'); enlarge.className = 'photo-enlarge'; enlarge.textContent = '⤢';
          enlarge.title = 'Enlarge'; enlarge.setAttribute('aria-label', 'Enlarge ' + source.name);
          enlarge.onclick = () => photoViewer.open(photoItems, photoSources.indexOf(source), enlarge);
          actions.append(enlarge);
        }
        if (source.href) {
          const link = document.createElement('a'); link.href = source.href; link.textContent = 'Report ↗';
          link.setAttribute('aria-label', 'Photo report ' + source.name); actions.append(link);
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
      ? 'Room assignments and relative cloud placement are unknown. Side-by-side layout is for inspection only.'
      : state.room && !roomNames().length
      ? 'No cameras are assigned to this room. Supporting photos and doorways are retained; the room geometry and placement are unknown.'
      : state.room && roomParts().length === 1
      ? 'Room membership is hypothesized. All photos share a geometric path; poses follow the selected branch.'
      : 'Room membership is hypothesized. Unaligned parts are arranged for inspection; their relative placement is unknown.';
    if (!semantic) return;
    get('room-source-control').hidden = semanticVariants.length < 2;
    options(get('room-source'), semanticVariants.map(v => [v.id, v.label]), state.roomSource);
    const choices = semantic.rooms.map((room, i) => [room.id, `${room.label || 'Hypothesis ' + (i + 1)} · ${room.names.length ? room.names.length + ' photos' : 'no assigned cameras'}`]);
    if (semantic.unassigned.length) choices.push(['unassigned', `Unassigned · ${semantic.unassigned.length} photos`]);
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
    const title = index < 0 ? 'Photos without room assignments' : semantic.rooms[index].label || `Room hypothesis ${index + 1}`;
    const details = get('room-details'); details.replaceChildren();
    const status = document.createElement('p');
    const ambiguous = names.filter(n => semantic.ambiguous.includes(n));
    status.textContent = `This is a hypothesis, not an established room. Geometric parts: ${parts.length}. `
      + (ambiguous.length ? `Alternative assignments: ${ambiguous.join(', ')}. ` : '')
      + (names.length ? 'Poses within each part follow the selected graph, including paths through photos outside this hypothesis.'
        : `No assigned cameras. Supporting photos: ${(semantic.rooms[index]?.evidence_photos || []).join(', ') || 'not specified'}. Placement and geometry are unknown.`);
    details.append(status);
    const evidence = document.createElement('a');
    const anchor = state.room === 'unassigned' && semantic.kind === 'global' ? semantic.call : state.room;
    evidence.href = semantic.href + '#' + anchor;
    evidence.textContent = 'Photos, evidence and alternatives ↗'; details.append(evidence);
    const doorways = semantic.doorways.filter(d => semantic.kind === 'global' ? d.room_pairs.flat().includes(state.room) : names.includes(d.a) || names.includes(d.b));
    const doorDetails = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = `Doorway hypotheses · ${semantic.kind === 'global' ? 'hypotheses' : 'pairwise evidence'}: ${doorways.length}`; doorDetails.append(summary);
    const list = document.createElement('ul');
    for (const door of doorways) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = door.href || semantic.href.replace(/rooms\.html$/, `vlm/pair-${String(door.evidence).padStart(4, '0')}.html`);
      link.textContent = semantic.kind === 'global'
        ? door.room_pairs[0].map(id => semantic.rooms.find(r => r.id === id)?.label || 'No assigned photo').join(' ↔ ')
        : door.label || `${door.a} ↔ ${door.b}`; item.append(link);
      item.append(document.createTextNode(door.assignment === 'global_hypothesis' ? ' · all-photo inference' : door.assignment === 'unique_hypotheses' ? ' · connection between room hypotheses' : ' · room assignment ambiguous / unknown'));
      list.append(item);
    }
    doorDetails.append(list); details.append(doorDetails);
    const recovery = semantic.kind === 'global' && settings.variants.find(v => v.recovery);
    const report = document.createElement('a');
    report.href = recovery ? recovery.recoveryInfo.href : settings.semantics.href + '#candidates';
    report.textContent = recovery ? 'Recovered connections and 3D checks ↗' : 'New overlap candidates and saved 3D variants ↗'; details.append(report);
    const section = document.createElement('section'); section.className = 'scene';
    const header = document.createElement('header'), heading = document.createElement('div'); heading.className = 'scene-heading';
    const h2 = document.createElement('h2'); h2.textContent = title;
    const expand = document.createElement('button'); expand.className = 'scene-expand'; expand.textContent = '⤢';
    expand.setAttribute('aria-label', 'Expand 3D'); expand.setAttribute('aria-haspopup', 'dialog'); expand.setAttribute('aria-expanded', 'false');
    heading.append(h2, expand); header.append(heading);
    const note = document.createElement('p'); note.className = 'warning';
    note.textContent = state.room === 'unassigned' ? 'Rooms are undetermined; relative cloud placement is unknown.'
      : !names.length ? 'Room hypothesis retained from supporting photos. No assigned cameras or reconstructed geometry.'
      : parts.length === 1 ? 'Hypothesized same room. One geometric part; poses from the selected graph.'
      : 'Hypothesized same room; relative placement of unaligned parts is unknown. Inspection layout, not a floor plan.'; header.append(note);
    const warnings = parts.reduce((n, p) => n + (p.component.warnings || 0), 0);
    if (warnings) { const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = `Original components have path conflicts: ${warnings}. The room view does not correct poses.`; header.append(warning); }
    const legend = document.createElement('div'); legend.className = 'room-legend';
    parts.forEach((part, i) => { const label = document.createElement('span'); label.textContent = `Part ${i + 1}: ${part.ids.join(', ')}`; legend.append(label); });
    header.append(legend);
    if (!names.length) {
      expand.hidden = true; section.append(header); get('scenes').append(section);
      get('room-extra').disabled = true; return;
    }
    const plot = document.createElement('div'); plot.className = 'plot'; plot.dataset.component = '__room__';
    section.append(header, plot); get('scenes').append(section);
    const view = {section, plot, key: `${state.variant.id}:${state.roomSource}:${state.room}`, nearby: true, needsInspection:true}; plots.set('__room__', view);
    expand.onclick = () => expandScene(view, expand); observer.observe(plot);
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
      entries.push({label: `Part ${parts.indexOf(part) + 1}`, data: await traces(part.component, groups)});
      if (version !== state.version) return;
    }
    const layout = window.planrecRoomView.layout(entries);
    const scene = {aspectmode: 'manual', aspectratio: fixedAspect(layout.ranges),
      camera: currentCamera(view.plot) || cameras.get(view.key) || roomCamera};
    ['xaxis', 'yaxis', 'zaxis'].forEach((axis, i) => { scene[axis] = {visible: false, range: layout.ranges[i], autorange: false}; });
    view.rendering = true;
    try {
      await renderer.react(view.plot, layout.data, {scene});
      restoreAnnotations(view);
    } finally { view.rendering = false; if (view.disposed) release(view); }
  }

  function restoreAnnotations(view) {
    if (!view.needsInspection) return;
    renderer.restoreInspection(view.plot, inspections.get(view.key)); view.needsInspection = false;
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
    get('model-label').textContent = matchers.size ? 'Depth' : 'Model';
    const reviewed = choices.find(v => v.model === state.variant.model && v.vlm && !v.recovery);
    const recovered = choices.find(v => v.model === state.variant.model && v.recovery);
    get('recovery-control').hidden = !recovered;
    get('recovery').disabled = !recovered || !state.variant.vlm;
    get('recovery').checked = !!state.variant.recovery;
    const recoveryStatus = get('recovery-status'); recoveryStatus.replaceChildren();
    recoveryStatus.hidden = !state.variant.recovery;
    if (state.variant.recovery) {
      const result = recovered.recoveryInfo;
      recoveryStatus.append(document.createTextNode(`Recovered bridges: ${result.bridges}; additional constraints: ${result.constraints}; total edges: ${result.edges}. Scale follows the anchor component; internal poses are preserved. `));
      const link = document.createElement('a'); link.href = result.href; link.textContent = 'Checks and scale corrections ↗'; recoveryStatus.append(link);
    }
    const visible = settings.multiview && !!state.variant.matcher;
    document.querySelector('.connection-options').hidden = !visible && !semanticVariants.length;
    get('vlm-control').hidden = !visible;
    get('vlm-status').hidden = !visible;
    get('vlm').disabled = !reviewed;
    get('vlm').checked = !!state.variant.vlm;
    const status = get('vlm-status'); status.replaceChildren();
    if (reviewed) {
      const result = reviewed.review;
      status.append(document.createTextNode(state.variant.vlm
        ? `VLM experiment: removed edges ${result.removed}; retained ${result.kept}, of which not supported by VLM ${result.unresolved}. `
        : 'Original geometry. A saved VLM experiment is available. '));
      status.append(document.createTextNode(`Checked pairs: ${result.checkedPairs}/${result.possiblePairs}. `));
      const link = document.createElement('a'); link.href = result.href;
      link.textContent = 'Decisions and evidence ↗'; status.append(link);
    } else {
      status.textContent = 'No saved VLM review for this combination.';
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
  if (['matcher', 'model', 'vlm', 'recovery'].some(key => params.has(key))) {
    const recovery = params.has('recovery') ? params.get('recovery') === '1' : state.variant.recovery;
    const vlm = params.has('vlm') ? params.get('vlm') === '1' : params.has('recovery') ? recovery : state.variant.vlm;
    state.variant = variantFor(params.get('matcher') || state.variant.matcher, params.get('model') || state.variant.model, vlm, vlm && recovery) || state.variant;
  }
  updateControls();
  get('all').onclick = () => { state.selected = new Set(state.room ? roomNames() : state.variant.sources.filter(s => !s.reference).map(s => s.id)); draw(); };
  get('none').onclick = () => { state.selected.clear(); draw(); };
  get('detail').onchange = () => { state.limit = Number(get('detail').value); draw(); };
  for (const id of ['point-size', 'cut-height', 'section-center', 'section-width', 'section-azimuth', 'section-tilt']) {
    get(id).oninput = () => { if (get(id).validity.valid) { tools.updateControlLabels(); scheduleDraw(); } };
  }
  for (const id of ['cutaway', 'section', 'section-axis', 'section-guide']) get(id).onchange = () => { tools.updateControlLabels(); draw(); };
  get('projection').onchange = draw;
  get('measure-units').onchange = () => renderer.refreshMeasurements();
  get('benchmark').onclick = async () => {
    const button = get('benchmark'); button.disabled = true;
    const output = get('benchmark-result'); output.textContent = 'Measuring rotation… Keep this view visible.';
    try {
      const view = [...plots.values()].find(v => v.plot.data && v.nearby);
      const result = await renderer.benchmark(view?.plot);
      result.detail = state.limit || 'full'; result.variant = state.variant.id;
      result.geometryBytesRequested = loadedBytes;
      output.textContent = JSON.stringify(result, null, 2);
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  };
  for (const button of get('representation').querySelectorAll('button')) button.onclick = () => {
    state.mode = button.dataset.mode;
    for (const other of get('representation').querySelectorAll('button')) other.setAttribute('aria-pressed', other === button);
    draw();
  };
  for (const id of ['colour', 'cameras', 'level', 'paths', 'axes']) get(id).onchange = draw;
  get('reset').onclick = () => { for (const view of plots.values()) if (view.plot.data) renderer.relayout(view.plot, {'scene.camera': state.room ? roomCamera : defaultCamera}); };
  for (const button of document.querySelectorAll('[data-orient]')) button.onclick = () => {
    for (const view of plots.values()) if (view.plot.data) renderer.orient(view.plot, button.dataset.orient);
  };
  get('measure').onchange = () => { renderer.setMeasuring(); tools.updateControlLabels(); };
  get('clear-measure').onclick = () => renderer.clearMeasurements();
  document.addEventListener('planrec-camera-open', event => {
    const sources = state.variant.sources.filter(source => source.photo);
    const index = sources.findIndex(source => source.id === event.detail?.id);
    if (index < 0) return;
    const items = sources.map(source => ({src: source.photo, caption: source.name, href: source.href}));
    photoViewer.open(items, index, event.target.querySelector('canvas'));
  });
  get('rooms').onchange = () => selectRoom(get('rooms').checked ? get('room-choice').value : null);
  get('room-choice').onchange = () => selectRoom(get('room-choice').value);
  get('room-source').onchange = () => selectRoomSource(get('room-source').value);
  get('room-extra').onchange = draw;
  const requestedRoom = params.get('room');
  const requestedSource = semanticVariants.find(v => v.semantics.rooms.some(r => r.id === requestedRoom));
  if (requestedSource) { state.roomSource = requestedSource.id; state.room = requestedRoom; }
  else if (settings.semantics && requestedRoom === 'unassigned' && settings.semantics.unassigned.length) state.room = requestedRoom;
  if (params.has('detail')) {
    const value = params.get('detail') === 'full' ? 0 : Number(params.get('detail'));
    if ([0, 1000, 2000, 5000, 10000, 25000, 100000, 250000].includes(value)) state.limit = value;
  }
  get('detail').value = String(state.limit);
  get('navigation-help').textContent = 'Drag: orbit · Shift/right-drag: pan · Scroll/pinch: zoom · Double-click: focus · Camera: click/tap for photo · F: reset · T: top';
  state.selected = new Set(state.room ? roomNames() : state.variant.initial);
  if (params.get('photos') === 'all') state.selected = new Set(state.variant.sources.filter(s => !s.reference).map(s => s.id));
  const sceneId = tools.sceneIdentity(settings);
  function captureView() {
    for (const view of plots.values()) if (view.plot.data) {
      cameras.set(view.key, currentCamera(view.plot)); inspections.set(view.key, renderer.inspectionState(view.plot));
    }
    const keys = new Set([...plots.values()].map(v => v.key));
    return {version:1, scene:sceneId, variant:state.variant.id, photos:[...state.selected], limit:state.limit,
      mode:state.mode, room:state.room, roomSource:state.roomSource, controls:tools.readControls(),
      cameras:Object.fromEntries([...cameras].filter(([key]) => keys.has(key))),
      inspections:Object.fromEntries([...inspections].filter(([key]) => keys.has(key))),
      expanded:expanded?.view.plot.dataset.component || null};
  }
  function applyView(saved) {
    const variant = settings.variants.find(v => v.id === saved.variant);
    if (!variant || saved.photos.some(id => !variant.sources.some(s => s.id === id))) throw new Error('Saved reconstruction or photos are no longer available.');
    if (saved.room && !semanticVariants.some(v => v.id === saved.roomSource && (saved.room === 'unassigned' || v.semantics.rooms.some(r => r.id === saved.room)))) throw new Error('Saved room hypothesis is no longer available.');
    ++state.version; collapseScene();
    for (const view of plots.values()) { view.discardState = true; release(view); }
    plots.clear(); cameras.clear(); inspections.clear();
    state.variant = variant; state.selected = new Set(saved.photos); state.limit = saved.limit; state.mode = saved.mode;
    state.room = saved.room || null; state.roomSource = saved.roomSource || 'pairwise';
    tools.writeControls(saved.controls); get('measure').checked = false; tools.updateControlLabels();
    if (settings.relativeScale) get('measure-units').value = 'm';
    get('detail').value = String(state.limit);
    for (const [key, value] of Object.entries(saved.cameras)) cameras.set(key, value);
    for (const [key, value] of Object.entries(saved.inspections || {})) inspections.set(key, value);
    updateControls(); updateRoomControls();
  }
  async function restoreView(saved) {
    applyView(saved); build();
    const deadline = performance.now() + 30000;
    while (drawing || ![...plots.values()].some(v => v.plot.data)) {
      if (!state.selected.size || !plots.size) return;
      if (performance.now() > deadline) throw new Error('View settings restored, but geometry has not finished loading.');
      await new Promise(requestAnimationFrame);
    }
    const view = saved.expanded && plots.get(saved.expanded);
    if (view) expandScene(view, view.section.querySelector('.scene-expand'));
  }
  tools.setupPanels(); tools.updateControlLabels();
  get('section-unit').textContent = coordinateUnit;
  if (settings.relativeScale) { get('measure-units').disabled = true; get('measure-units').replaceChildren(new Option('Relative units','m')); }
  const initialView = tools.setupBookmarks({scene:sceneId, capture:captureView, restore:restoreView});
  if (initialView) await restoreView(initialView);
  else { updateRoomControls(); build(); }
})().catch(error => { document.getElementById('loading').textContent = 'Unable to start the 3D viewer. ' + error.message; });

/* Static scene viewer. Geometry is immutable; selection changes visibility only. */
(async () => {
  'use strict';
  const settings = JSON.parse(document.getElementById('scene-data').textContent);
  const assetQuery = new URL(document.currentScript.src).search;
  const renderer = await import('./three-renderer.js' + assetQuery);
  const {decodePoints, transformedBounds, detailChoices, pointAssetUrl, selectedSupport, visiblePointCount} = await import('./cloud-buffers.js' + assetQuery);
  const tools = await import('./viewer-tools.js' + assetQuery);
  const {setupAdjustments} = await import('./mobile-tools.js' + assetQuery);
  const {comparisonCandidates, comparisonSelection, comparisonRanges, cameraAxes, identityPose} = await import('./cloud-comparison.js' + assetQuery);
  const {fields, facets, fieldOptions, selectField, selectConnections, sameConfiguration} = await import('./cloud-options.js' + assetQuery);
  let coordinateUnit;
  const get = id => document.getElementById(id);
  const photoViewer = window.planrecPhotoViewer();
  const palette = ['#168575', '#ce621c', '#6551c5', '#bd3c8a', '#267bb7', '#7c4f37', '#85801d'];
  const defaultCamera = {eye: {x: 1.35, y: -1.8, z: .8}, up: {x: 0, y: 0, z: 1}, center: {x: 0, y: 0, z: 0}, fit: true};
  const roomCamera = {eye: {x: 0, y: -2.1, z: 1}, up: {x: 0, y: 0, z: 1}, center: {x: 0, y: 0, z: 0}, fit: true};
  const preferred = settings.variants.find(v => v.id === settings.defaultVariant) || settings.variants[0];
  const state = {variant: preferred, selected: new Set(), limit: settings.defaultLimit ?? 100000, mode: 'points', version: 0, room: null, roomSource: 'pairwise', compare: false, compareModels: new Set(), compareCustom: false, comparePhoto: null};
  let comparisonCamera = null;
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
    if (view.plot.dataset.navigation === 'explore') renderer.navigate(view.plot,'inspect');
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
    const tools = ['detail-control', 'view-controls', 'inspection-footer'].map(id => {
      const control = get(id), slot = document.createElement('span');
      control.before(slot);
      (id === 'inspection-footer' ? view.section : view.section.querySelector('header')).append(control);
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
    syncNavigation();
  }

  function activeView() { return expanded?.view || [...plots.values()].find(v => v.nearby && v.plot.data); }
  function syncNavigation() {
    const view = activeView(), photos = view?.plot.layout?.scene.photoViews || [], select = get('photo-view');
    if (view && !expanded && get('inspection-footer').parentElement !== view.section) view.section.append(get('inspection-footer'));
    const current = photos.some(p => p.id === select.value) ? select.value : photos[0]?.id || '';
    if (Array.from(select.options,o => o.value).join() !== photos.map(p => p.id).join()) select.replaceChildren(...photos.map(p => new Option(p.name,p.id)));
    select.value = view?.plot.dataset.navigation === 'explore' && photos.some(p => p.id === view.plot.dataset.viewpoint) ? view.plot.dataset.viewpoint : current;
    get('jump-photo').disabled = get('open-view-photo').disabled = !select.value;
    get('navigation').value = view?.plot.dataset.navigation || 'inspect';
    get('navigation-status').textContent = get('navigation').value === 'explore'
      ? `Exploring this aligned group · ${photos.find(p => p.id === select.value)?.name || 'current position'} · return to Inspect for the previous overview.` : '';
    tools.updateControlLabels();
  }
  async function explorePhoto(id) {
    try {
      if (id && state.room && roomParts().length > 1) selectRoom(null);
      const component = id && state.variant.components.find(c => c.ids.includes(id));
      const selectedComponent = state.variant.components.find(c => c.ids.some(photo => state.selected.has(photo)));
      const view = component ? plots.get(state.room ? '__room__' : component.id)
        : activeView() || plots.get(state.room ? '__room__' : selectedComponent?.id);
      if (!view) throw new Error('Select a photo or aligned group first.');
      const meshComponent = state.variant.wholeComponentMesh && (component || state.variant.components.find(c => c.id === view.plot.dataset.component));
      if (state.variant.wholeComponentMesh && !meshComponent?.mesh) throw new Error('This group has no saved mesh. Choose Points or Surfels to explore its photos.');
      if (expanded && expanded.view !== view) collapseScene();
      if (meshComponent) for (const photo of meshComponent.ids) state.selected.add(photo);
      else if (id) state.selected.add(id);
      if (!expanded) expandScene(view,view.section.querySelector('.scene-expand'));
      view.nearby = true; await draw();
      const deadline = performance.now() + 20000;
      while (!view.plot.data || drawing) {
        if (expanded?.view !== view) return;
        if (!view.plot.isConnected || performance.now() > deadline) throw new Error('This viewpoint is not ready. Try again after the cloud loads.');
        await new Promise(requestAnimationFrame);
      }
      if (expanded?.view !== view) return;
      if (!renderer.navigate(view.plot,'explore',id)) throw new Error('Explore needs one aligned group. Open a photo viewpoint to explore its group separately.');
      get('measure').checked = false; renderer.setMeasuring();
      for (const panel of document.querySelectorAll('.tool-panel')) panel.open = false;
      view.plot.querySelector('canvas').focus({preventScroll:true}); syncNavigation();
    } catch (error) { get('navigation').value = 'inspect'; tools.updateControlLabels(); get('navigation-status').textContent = error.message; get('orientation-panel').open = true; }
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
      const pending = fetch(pointAssetUrl(asset, location.hostname)).then(async response => {
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

  function photoIds(ids) {
    const references = new Set(state.variant.sources.filter(s => s.reference).map(s => s.id));
    return ids.filter(id => !references.has(id));
  }

  function selectionGroups() {
    const membership = new Map(), counts = new Map(); let next = 0;
    for (const component of state.variant.components) {
      const ids = photoIds(component.ids).filter(id => state.selected.has(id));
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

  async function preparedSurface(source, component, asset) {
    const key = `${state.variant.id}:${source.id}:${asset.key}`;
    const signature = String(get('level').checked);
    const prior = geometry.get(key);
    if (prior?.signature === signature) return prior.data;
    const rotation = get('level').checked ? component.rotation : component.fixed;
    const chunks = [asset];
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
  function photoViews(component) {
    return state.variant.sources.filter(s => s.photo && !s.unavailableReason && component.ids.includes(s.id)).map(source => {
      const origin = position([0,0,0],source,component), forward = position([0,0,1],source,component);
      return {id:source.id,name:source.name,position:origin,direction:forward.map((n,i) => n - origin[i]),frame:component.id};
    });
  }

  async function traces(component, groups) {
    const sources = state.variant.sources.filter(s => component.ids.includes(s.id));
    const photoNames = new Map(sources.map(source => [source.id, source.name]));
    const selected = sources.filter(s => state.selected.has(s.id) || selectedSupport(s, state.selected));
    const output = (await Promise.all(selected.map(async source => {
      const list = [], hover = `x: %{x:.2f} ${coordinateUnit}<br>y: %{y:.2f} ${coordinateUnit}<br>z: %{z:.2f} ${coordinateUnit}<extra>${source.name}</extra>`;
      if (state.mode !== 'planes' && !state.variant.wholeComponentMesh) {
        const limit = state.limit || Infinity;
        const chunks = await Promise.all(source.chunks.filter(c => c.start < limit).map(loadDense));
        const rotation = get('level').checked ? component.rotation : component.fixed;
        const cloud = {id: source.id, chunks, pose: source.pose, rotation, limit, frame: component.id,
          unitLabel: coordinateUnit, selectionMask: selectedSupport(source, state.selected),
          supportNames: source.supportIds?.map(id => photoNames.get(id) || id)};
        list.push({type: 'scatter3d', mode: 'markers', name: source.name, cloud,
          bounds: transformedBounds(source.bounds, source.pose, rotation),
          marker: {color: get('colour').value === 'rgb' ? 'photo' : colour(source, groups, {}, 'points')},
          showlegend: false, hovertemplate: hover});
      }
      if (state.mode !== 'points' && source.planes?.triangles) {
        const data = await preparedSurface(source, component, source.planes), colors = colour(source, groups, data, 'planes');
        list.push({type: 'mesh3d', name: source.name, x: data.x, y: data.y, z: data.z, i: data.i, j: data.j, k: data.k,
          surface: {id: source.id, frame: component.id, unitLabel: coordinateUnit, pose: source.pose,
            rotation: get('level').checked ? component.rotation : component.fixed},
          ...(typeof colors === 'string' ? {color: colors} : {vertexcolor: colors}), flatshading: true,
          lighting: {ambient: .8, diffuse: .35, specular: 0}, showlegend: false, hovertemplate: hover});
      }
      if (get('cameras').checked && state.selected.has(source.id)) list.push(cameraTrace(source, component, groups));
      return list;
    }))).flat();
    if (state.variant.wholeComponentMesh && component.mesh && selected.length) {
      const source = {id:`mesh:${component.id}`, pose:component.mesh.pose};
      const data = await preparedSurface(source, component, component.mesh);
      output.push({type:'mesh3d', name:'TSDF mesh · whole saved group',
        x:data.x, y:data.y, z:data.z, i:data.i, j:data.j, k:data.k,
        vertexcolor:data.rgb, flatshading:false,
        surface:{id:source.id, frame:component.id, unitLabel:coordinateUnit, pose:source.pose,
          rotation:get('level').checked ? component.rotation : component.fixed},
        lighting:{ambient:.8, diffuse:.35, specular:0}, showlegend:false});
    }
    for (const hypothesis of state.variant.hypotheses || []) {
      if (!hypothesis.supportIds.some(id => component.ids.includes(id) && state.selected.has(id))) continue;
      const rotation = get('level').checked ? component.rotation : component.fixed;
      const vertices = hypothesis.vertices.map(p => rotate(p, rotation));
      output.push({type:'scatter3d', mode:'lines', name:hypothesis.label,
        x:vertices.map(p=>p[0]), y:vertices.map(p=>p[1]), z:vertices.map(p=>p[2]),
        line:{color:'#c47b32',width:5}, hoverinfo:'name',showlegend:false});
    }
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
      const source = state.variant.sources.find(s => s.id === id);
      const noMesh = state.variant.wholeComponentMesh && state.variant.components.some(c => c.ids.includes(id) && !c.mesh);
      card.querySelector('.badge').textContent = noMesh ? 'No saved mesh' : source?.unavailableReason ? 'No saved geometry'
        : hiddenExtra ? 'Hidden: unaligned' : selected ? (source?.reference ? 'Reference overlay' : state.variant.edges === null ? 'Visible' : `Subgroup ${(group || 0) + 1}`) : 'Hidden';
    }
    const split = [...groups.counts.values()].some(n => n > 1);
    get('selection-status').classList.toggle('split', split);
    const selectedPhotos = photoIds([...state.selected]), references = state.selected.size - selectedPhotos.length;
    let text = `Selected ${selectedPhotos.length} of ${state.room ? roomNames().length : photoIds(state.variant.sources.map(s => s.id)).length}`;
    if (references) text += ` · reference overlays: ${references}`;
    if (state.room) text += ' in the hypothesized room' + (!roomNames().length ? ' · no assigned cameras' : roomParts().length > 1 ? ' · parts arranged for inspection' : ' · one geometric part');
    if (split) text += ` · visible subgroups: ${groups.total}`;
    const unavailable = state.variant.sources.filter(s => s.unavailableReason && state.selected.has(s.id)).length;
    if (unavailable) text += ` · photos without saved geometry: ${unavailable}`;
    else if (settings.multiview) text += ' · full-group poses retained';
    get('selection-status').textContent = text + '.';
    const shown = state.room && !get('room-extra').checked ? new Set(roomParts()[0]?.ids || []) : state.selected;
    const visiblePhotos = new Set([...state.selected].filter(id => shown.has(id)));
    const selected = state.variant.sources.filter(s => visiblePhotos.has(s.id) || selectedSupport(s, visiblePhotos));
    syncDetail(selected.length ? selected : state.variant.sources);
    const counts = selected.map(s => visiblePointCount(s, visiblePhotos, state.limit));
    const count = counts.includes(null) ? null : counts.reduce((a, b) => a + b, 0);
    const patches = selected.reduce((n, s) => n + (s.planes?.count || 0), 0);
    const faces = selected.reduce((n, s) => n + (s.planes?.triangles || 0), 0);
    const coverage = selected.filter(s => s.planes).map(s => 100 * s.planes.coverage);
    const hypotheses = (state.variant.hypotheses || []).filter(h => h.supportIds.some(id => visiblePhotos.has(id)));
    const unit = state.variant.sources.some(s => s.supportIds) ? 'unique surfels' : 'points';
    get('counts').textContent = [state.mode !== 'planes' ? (count === null ? 'Selected surface · custom point limit' : `${count.toLocaleString('en')} ${unit}`) : '',
      hypotheses.length ? `${hypotheses.length} inferred wall bounds` : '',
      state.mode !== 'points' ? `${patches} patches · ${faces.toLocaleString('en')} triangles` : '',
      state.mode !== 'points' && coverage.length ? `photo coverage: ${Math.min(...coverage).toFixed(0)}–${Math.max(...coverage).toFixed(0)}%` : ''].filter(Boolean).join(' · ');
    if (state.variant.wholeComponentMesh) {
      const meshes = state.variant.components.filter(c => c.mesh && c.ids.some(id => visiblePhotos.has(id)));
      const triangles = meshes.reduce((n, c) => n + c.mesh.triangles, 0);
      const vertices = meshes.reduce((n, c) => n + c.mesh.vertices, 0);
      get('counts').textContent = `${triangles.toLocaleString('en')} triangles · ${vertices.toLocaleString('en')} vertices · whole saved groups`;
    }
    get('detail').hidden = state.mode === 'planes' || !!state.variant.wholeComponentMesh;
    get('detail-control').firstElementChild.hidden = get('detail').hidden;
    get('plane-note').hidden = state.mode === 'points';
    get('mesh-note').hidden = !state.variant.wholeComponentMesh;
    for (const group of get('photos').querySelectorAll('.photo-group')) {
      const button = group.querySelector('.group-only');
      if (!button) continue;
      const ids = photoIds(state.variant.components.find(c => c.id === group.dataset.component).ids).filter(id => !state.room || roomNames().includes(id));
      button.setAttribute('aria-pressed', ids.length === selectedPhotos.length && ids.every(id => state.selected.has(id)));
    }
  }

  function syncDetail(sources) {
    const {maximum, levels, selected} = detailChoices(sources, state.limit);
    const control = get('detail');
    const shared = !state.compare && state.variant.sources.some(s => s.supportIds);
    const unit = shared ? 'buffer' : 'photo';
    get('detail-unit').textContent = `per ${unit}`;
    control.setAttribute('aria-label', `Point limit per ${unit}`);
    const options = levels.map(n => new Option(`${n / 1000}k`, String(n)));
    options.push(new Option(`All saved (≤${maximum.toLocaleString('en')}/${unit})`, '0'));
    control.replaceChildren(...options); control.value = String(selected);
    control.disabled = maximum === 0;
    control.title = shared
      ? 'The limit applies to each saved surfel buffer before selection by supporting photos. One photo can draw from several buffers.'
      : 'Only counts below the saved maximum are offered. All saved includes every point exported to this view; a report may use a display sample.';
  }

  function updateComparisonControls() {
    const candidates = state.variant.wholeComponentMesh ? [] : comparisonCandidates(settings, state.variant);
    get('compare-toggle').hidden = candidates.length < 2;
    if (candidates.length < 2) state.compare = false;
    get('compare-toggle').setAttribute('aria-pressed', state.compare);
    get('compare-toggle').textContent = state.compare ? 'Return to scene' : 'Compare geometry';
    get('compare-controls').hidden = !state.compare;
    if (!state.compare) return candidates;
    const {models, custom} = comparisonSelection(candidates, state.variant, state.compareModels, state.compareCustom);
    if (models.length !== state.compareModels.size || models.some(id => !state.compareModels.has(id))) comparisonCamera = null;
    state.compareModels = new Set(models);
    state.compareCustom = custom;
    get('compare-model-summary').textContent = `Results to compare · ${models.length} selected`;
    const photos = new Map(candidates.flatMap(c => c.sources.map(s => [s.id, s])));
    if (!photos.has(state.comparePhoto)) state.comparePhoto = [...state.selected].find(id => photos.has(id)) || photos.keys().next().value;
    get('compare-photo').replaceChildren(...[...photos].map(([id, s]) => new Option(s.name, id)));
    get('compare-photo').value = state.comparePhoto;
    const photo = photos.get(state.comparePhoto);
    get('compare-preview').hidden = !photo?.photo;
    if (photo?.photo) get('compare-preview').src = photo.photo;
    const choices = candidates.map(candidate => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = candidate.id; input.checked = state.compareModels.has(candidate.id);
      input.disabled = !input.checked && state.compareModels.size >= 4;
      input.onchange = () => {
        if (input.checked) state.compareModels.add(candidate.id); else state.compareModels.delete(candidate.id);
        if (!state.compareModels.size) state.compareModels.add(candidate.id);
        state.compareCustom = true;
        comparisonCamera = null; build();
        [...get('compare-models').querySelectorAll('input')].find(choice => choice.value === candidate.id)?.focus({preventScroll: true});
      };
      label.append(input, document.createTextNode(candidate.label || candidate.model || candidate.id)); return label;
    });
    get('compare-models').replaceChildren(...choices);
    return candidates;
  }

  function buildComparison(candidates) {
    get('scenes').classList.add('comparison-grid');
    for (const candidate of candidates.filter(c => state.compareModels.has(c.id))) {
      const section = document.createElement('section'), header = document.createElement('header');
      const heading = document.createElement('h2'), plot = document.createElement('div');
      section.className = 'scene'; plot.className = 'plot';
      heading.textContent = candidate.label || candidate.model || candidate.id; header.append(heading);
      const source = candidate.sources.find(s => s.id === state.comparePhoto);
      section.append(header, plot); get('scenes').append(section);
      if (!source || source.unavailableReason) { plot.className = 'scene-empty'; plot.textContent = source?.unavailableReason || 'This model has no saved prediction for this photo.'; continue; }
      const view = {section, plot, source, candidate, key:`compare:${candidate.id}:${source.id}`, nearby:true, needsInspection:true};
      plots.set(candidate.id, view);
    }
    get('representation').hidden = true;
    get('detail').hidden = false; get('detail-control').firstElementChild.hidden = false;
    get('plane-note').hidden = true;
    get('mesh-note').hidden = true;
    get('level-label').hidden = true; get('paths-label').hidden = true;
    get('navigation').value = 'inspect'; get('navigation').disabled = true;
  }

  async function drawComparison(version) {
    const views = [...plots.values()], sources = views.map(v => v.source), ranges = comparisonRanges(sources);
    syncDetail(sources);
    const count = sources.reduce((sum, source) => sum + Math.min(state.limit || Infinity, source.available), 0);
    get('counts').textContent = `${count.toLocaleString('en')} points across ${sources.length} model panels`;
    get('selection-status').textContent = `One photo · ${sources.length} saved model panels · linked cameras · shared numeric axis ranges.`;
    for (const view of views) {
      const source = view.source, limit = state.limit || Infinity;
      const comparisonUnit = (view.candidate.relativeScale ?? settings.relativeScale) ? 'rel. units' : 'm';
      const chunks = await Promise.all(source.chunks.filter(c => c.start < limit).map(loadDense));
      if (version !== state.version) return;
      const cloud = {id:source.id, chunks, pose:identityPose, rotation:cameraAxes, limit,
        frame:view.key, unitLabel:comparisonUnit};
      const data = [{type:'scatter3d', mode:'markers', name:view.candidate.label, cloud,
        bounds:transformedBounds(source.bounds, identityPose, cameraAxes),
        marker:{color:get('colour').value === 'rgb' ? 'photo' : palette[views.indexOf(view) % palette.length]}}];
      if (get('cameras').checked) {
        const component = {rotation:cameraAxes, fixed:cameraAxes};
        data.push(cameraTrace({...source, pose:identityPose}, component, {membership:new Map()}));
      }
      const scene = {camera:comparisonCamera || defaultCamera, aspectmode:'manual', aspectratio:fixedAspect(ranges),
        unitLabel:comparisonUnit, linkedCamera:true, canExplore:false};
      ['xaxis', 'yaxis', 'zaxis'].forEach((axis, i) => { scene[axis] = {title:{text:['camera x','camera z','camera −y'][i] + ', ' + comparisonUnit},range:ranges[i],autorange:false}; });
      view.rendering = true;
      try { await renderer.react(view.plot, data, {scene}); restoreAnnotations(view); }
      finally { view.rendering = false; if (view.disposed) release(view); }
      if (version !== state.version) return;
      comparisonCamera ||= currentCamera(view.plot);
    }
  }

  document.addEventListener('planrec-camera-change', event => {
    if (!state.compare) return;
    comparisonCamera = event.detail;
    for (const view of plots.values()) if (view.plot !== event.target && view.plot.data) {
      renderer.relayout(view.plot, {'scene.camera': comparisonCamera});
    }
  });

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
    if (!state.compare) updateSelection(groups);
    get('top').title = get('level').checked && state.variant.components.every(c => c.levelled) ? 'Along estimated vertical' : 'Along displayed Z (camera −y); physical vertical unknown';
    get('loading').textContent = 'Preparing 3D…';
    try {
      if (state.compare) await drawComparison(version);
      else if (state.room) await drawRoom(version, groups);
      else for (const component of state.variant.components) {
        const view = plots.get(component.id), visible = component.ids.some(id => state.selected.has(id));
        view.section.hidden = !visible;
        // Many SIFT components can be isolated. Only nearby plots keep WebGL contexts.
        if (!visible || !view.nearby || component.unavailableReason) { release(view); continue; }
        const data = await traces(component, groups);
        if (version !== state.version) return;
        const level = get('level').checked && component.levelled;
        const ranges = level ? component.ranges : component.rawRanges;
        const labels = (level ? ['x', 'y', 'z up'] : ['camera x', 'camera z', 'camera -y']).map(axis => axis + ', ' + coordinateUnit);
        const camera = currentCamera(view.plot) || cameras.get(view.key) || defaultCamera;
        const scene = {aspectmode: 'manual', aspectratio: fixedAspect(ranges), camera, photoViews:photoViews(component), unitLabel:coordinateUnit};
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
      if (version === state.version) get('loading').textContent = state.compare || state.selected.size ? '' : 'Select photos below.';
      if (version === state.version) get('render-stats').textContent = `Ready in ${Math.round(performance.now() - started)} ms · ${(loadedBytes / 1e6).toFixed(1)} MB requested this session`;
      if (version === state.version) syncNavigation();
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
    if (state.variant.wholeComponentMesh) {
      state.room = null;
      state.selected = new Set(state.variant.components
        .filter(c => c.ids.some(id => state.selected.has(id))).flatMap(c => c.ids));
    }
    updateRoomControls();
    collapseScene();
    get('scenes').after(get('inspection-footer'));
    observer?.disconnect();
    for (const view of plots.values()) release(view);
    plots.clear(); geometry.clear(); get('scenes').replaceChildren(); get('photos').replaceChildren();
    const candidates = updateComparisonControls();
    get('scenes').classList.remove('comparison-grid');
    get('photo-controls').hidden = get('photos').hidden = state.compare;
    const selectionLink = document.querySelector('a[href="#photo-controls"]');
    if (selectionLink) selectionLink.parentElement.hidden = state.compare;
    const shared = !state.compare && state.variant.sources.some(s => s.supportIds);
    const sourceColourOption = get('colour').querySelector('option[value="source"]');
    sourceColourOption.textContent = shared ? 'Surfel storage group' : 'Source';
    sourceColourOption.title = shared ? 'Colours follow the photo used to store each surfel. Pick the surfel to inspect its supporting photos.' : '';
    get('colour').disabled = !!state.variant.wholeComponentMesh;
    if (state.variant.wholeComponentMesh) get('colour').value = 'rgb';
    get('point-size').disabled = !!state.variant.wholeComponentMesh;
    get('point-size-control').hidden = !!state.variant.wholeComponentMesh;
    for (const button of document.querySelectorAll('[data-adjust="point-size"]')) button.hidden = !!state.variant.wholeComponentMesh;
    get('photo-selection-hint').textContent = state.variant.wholeComponentMesh
      ? 'Select whole groups; photo thumbnails show the saved inputs.'
      : 'Select a thumbnail to show or hide it';
    get('navigation').disabled = false;
    if (state.compare) { buildComparison(candidates); draw(); return; }
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
    const isolated = sorted.filter(c => photoIds(c.ids).length === 1).length;
    const hasGraph = state.variant.edges !== null;
    let isolatedGrid;
    for (let index = 0; index < sorted.length; index++) {
      const component = sorted[index], section = document.createElement('section'), header = document.createElement('header'), plot = document.createElement('div');
      section.className = 'scene' + (index ? ' secondary' : ''); plot.className = 'plot';
      const photoCount = photoIds(component.ids).length, referenceCount = component.ids.length - photoCount;
      const title = document.createElement('h2'); title.textContent = `Group ${Number(component.id) + 1} · ${settings.multiview ? 'photos' : 'sources'}: ${photoCount}` + (referenceCount ? ` · reference overlays: ${referenceCount}` : '');
      const heading = document.createElement('div'); heading.className = 'scene-heading';
      const expand = document.createElement('button'); expand.className = 'scene-expand';
      expand.textContent = '⤢'; expand.title = 'Expand 3D';
      expand.setAttribute('aria-label', 'Expand 3D'); expand.setAttribute('aria-haspopup', 'dialog');
      expand.setAttribute('aria-expanded', 'false'); heading.append(title, expand); header.append(heading);
      if (component.unavailableReason) {
        expand.hidden = true; plot.className = 'scene-empty';
        plot.textContent = component.unavailableReason;
      } else if (index) {
        const note = document.createElement('p');
        note.textContent = 'Separate coordinate frame · placement relative to other groups is unknown';
        header.append(note);
      }
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
      const singleton = !state.room && photoCount === 1 && isolated > 1;
      let grid = singleton ? isolatedGrid : null;
      if (!grid) {
        const group = document.createElement('div'); group.className = 'photo-group'; group.dataset.component = component.id;
        const heading = document.createElement('div'); heading.className = 'group-heading';
        const label = document.createElement('span');
        label.textContent = state.room ? `Part ${index + 1} · ${photoCount} photos` + (sorted.length > 1 ? ' · placement relative to other parts is unknown' : ' · saved poses')
          : singleton ? `${hasGraph ? 'No accepted connections' : 'Separate photo frames'} · photos: ${isolated}`
          : title.textContent + (index && hasGraph ? ' · no accepted connection to the main group' : '');
        heading.append(label);
        if (settings.multiview && !singleton) {
          const only = document.createElement('button'); only.className = 'group-only'; only.textContent = 'Only this group';
          only.setAttribute('aria-label', `Show only group ${Number(component.id) + 1}`);
          only.onclick = () => { state.selected = new Set(photoIds(component.ids)); draw(); };
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
        if (state.variant.wholeComponentMesh) {
          button.disabled = true;
          button.title = 'The mesh uses the whole saved group. Use Points or Surfels to select individual photos.';
        }
        button.onclick = () => { if (!state.selected.delete(source.id)) state.selected.add(source.id); draw(); };
        card.append(button);
        const actions = document.createElement('div'); actions.className = 'photo-actions';
        if (source.photo) {
          const enlarge = document.createElement('button'); enlarge.className = 'photo-enlarge'; enlarge.textContent = '⤢';
          enlarge.title = 'Enlarge'; enlarge.setAttribute('aria-label', 'Enlarge ' + source.name);
          enlarge.onclick = () => photoViewer.open(photoItems, photoSources.indexOf(source), enlarge);
          actions.append(enlarge);
          if (!source.unavailableReason && !component.unavailableReason) {
            const viewpoint = document.createElement('button'); viewpoint.className = 'photo-viewpoint'; viewpoint.textContent = 'Viewpoint';
            viewpoint.setAttribute('aria-label','Explore from ' + source.name); viewpoint.onclick = () => explorePhoto(source.id);
            card.append(viewpoint);
          }
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
    const firstScene = get('scenes').querySelector('.scene'); if (firstScene) firstScene.append(get('inspection-footer'));
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
    get('rooms').disabled = !!state.variant.wholeComponentMesh;
    get('rooms').title = state.variant.wholeComponentMesh
      ? 'Room-specific mesh boundaries are unknown. Use Points or Surfels for room hypotheses.' : '';
    get('room-controls').hidden = !state.room;
    get('rooms').checked = !!state.room;
    get('room-warning').textContent = state.room === 'unassigned'
      ? 'Room assignments and relative cloud placement are unknown. Side-by-side layout is for inspection only.'
      : state.room && !roomNames().length
      ? 'No cameras are assigned to this room. Supporting photos and doorways are retained; the room geometry and placement are unknown.'
      : state.room && roomParts().length === 1
          ? 'Room membership is hypothesized. These photos share a saved coordinate frame.'
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
      + (names.length ? (state.variant.edges === null
        ? 'Each part uses the selected reconstruction’s saved poses.'
        : 'Each part uses saved graph poses. Placement can involve photos outside this hypothesis.')
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
    const recovery = semantic.kind === 'global' && (state.variant.recoveryInfo || settings.variants.find(v => v.recovery)?.recoveryInfo);
    const report = document.createElement('a');
    report.href = recovery ? recovery.href : settings.semantics.href + '#candidates';
    report.textContent = recovery
      ? state.variant.recovery ? 'Recovered connections and 3D checks ↗' : 'Alignment recovery experiment ↗'
      : 'New overlap candidates and saved 3D variants ↗';
    details.append(report);
    const section = document.createElement('section'); section.className = 'scene';
    const header = document.createElement('header'), heading = document.createElement('div'); heading.className = 'scene-heading';
    const h2 = document.createElement('h2'); h2.textContent = title;
    const expand = document.createElement('button'); expand.className = 'scene-expand'; expand.textContent = '⤢';
    expand.setAttribute('aria-label', 'Expand 3D'); expand.setAttribute('aria-haspopup', 'dialog'); expand.setAttribute('aria-expanded', 'false');
    heading.append(h2, expand); header.append(heading);
    const note = document.createElement('p'); note.className = 'warning';
    note.textContent = state.room === 'unassigned' ? 'Rooms are undetermined; relative cloud placement is unknown.'
      : !names.length ? 'Room hypothesis retained from supporting photos. No assigned cameras or reconstructed geometry.'
      : parts.length === 1 ? 'Hypothesized same room. One geometric part with saved poses.'
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
      entries.push({label: `Part ${parts.indexOf(part) + 1}`, data: await traces(part.component, groups), photoViews:photoViews(part.component).filter(p => part.ids.includes(p.id))});
      if (version !== state.version) return;
    }
    const layout = window.planrecRoomView.layout(entries);
    const scene = {aspectmode: 'manual', aspectratio: fixedAspect(layout.ranges),
      camera: currentCamera(view.plot) || cameras.get(view.key) || roomCamera, unitLabel:coordinateUnit, canExplore:entries.length === 1,
      photoViews:entries.flatMap((entry,i) => entry.photoViews.map(p => ({...p,position:p.position.map((n,j) => n + layout.offsets[i][j])})))};
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
  for (const [field, label] of fields) {
    const control = document.createElement('label'); control.id = field + '-control'; control.hidden = true;
    control.append(document.createTextNode(label + ' '));
    const select = document.createElement('select'); select.id = field; control.append(select);
    get(field === 'inputGrouping' ? 'input-group-options' : 'model-options').append(control);
    select.onchange = () => chooseVariant(selectField(settings.variants, state.variant, field, select.value));
  }
  function updateControls() {
    for (const [field] of fields) {
      const values = fieldOptions(settings.variants, state.variant, field);
      options(get(field), values, facets(state.variant)[field]?.id);
      get(field + '-control').hidden = values.size < 2;
    }
    const relative = state.variant.relativeScale ?? settings.relativeScale ?? false;
    coordinateUnit = relative ? 'rel. units' : 'm';
    get('section-unit').textContent = coordinateUnit;
    get('explore-speed-unit').textContent = coordinateUnit + '/s';
    get('measure-units').disabled = relative;
    const previousUnit = get('measure-units').value;
    get('measure-units').replaceChildren(...(relative ? [new Option('Relative units', 'm')]
      : [new Option('Metres', 'm'), new Option('Centimetres', 'cm')]));
    get('measure-units').value = relative ? 'm' : previousUnit || 'm';
    get('scale-note').textContent = relative ? 'Relative model units; absolute scale is not established.'
      : 'Scale comes from predicted depth, not a measured room dimension.';
    const choicesForDescription = facets(state.variant);
    const description = state.variant.description || fields.map(([field]) => field === 'fusion' && choicesForDescription.surface && choicesForDescription.fusion?.id === 'none'
      ? null : choicesForDescription[field]?.label).filter(Boolean).join(' · ');
    const connectionLabel = ['matching', 'fusion'].includes(facets(state.variant).method?.id)
      ? state.variant.recovery ? ' · VLM review + recovery' : state.variant.vlm ? ' · VLM review' : ' · Geometric connections only' : '';
    get('variant-description').textContent = description + connectionLabel;
    const evidence = get('variant-report'); evidence.hidden = !state.variant.report;
    if (state.variant.report) evidence.href = state.variant.report;
    const choices = settings.variants.filter(v => sameConfiguration(v, state.variant));
    const reviewed = choices.find(v => v.vlm && !v.recovery && v.review);
    const recovered = choices.find(v => v.recovery && v.recoveryInfo);
    const reviewEvidence = reviewed?.review || state.variant.review;
    get('recovery-control').hidden = !recovered;
    get('recovery').disabled = !recovered || !state.variant.vlm || !choices.some(v => v.vlm && !v.recovery);
    get('recovery').title = get('recovery').disabled && state.variant.recovery
      ? 'This surface was saved with recovery on. No matched recovery-off surface is available.' : '';
    get('recovery').checked = !!state.variant.recovery;
    const recoveryStatus = get('recovery-status'); recoveryStatus.replaceChildren();
    recoveryStatus.hidden = !state.variant.recovery;
    if (state.variant.recovery) {
      const result = recovered.recoveryInfo;
      recoveryStatus.append(document.createTextNode(`Recovered bridges: ${result.bridges}; additional constraints: ${result.constraints}; total edges: ${result.edges}. Scale follows the anchor component; internal poses are preserved. `));
      const link = document.createElement('a'); link.href = result.href; link.textContent = 'Checks and scale corrections ↗'; recoveryStatus.append(link);
    }
    const visible = !!reviewEvidence || !!recovered;
    const inputGrouping = !get('inputGrouping-control').hidden;
    get('input-group-options').hidden = !inputGrouping;
    get('connection-summary').textContent = inputGrouping ? 'Connections and input grouping' : 'Connections and room hypotheses';
    document.querySelector('.connection-options').hidden = !visible && !semanticVariants.length && !inputGrouping;
    get('vlm-control').hidden = !visible;
    get('vlm-status').hidden = !visible && !semanticVariants.length;
    get('vlm').disabled = !reviewed || !choices.some(v => !v.vlm);
    get('vlm').title = get('vlm').disabled && state.variant.vlm
      ? 'This surface was saved with VLM review on. No matched review-off surface is available.' : '';
    get('vlm').checked = !!state.variant.vlm;
    const status = get('vlm-status'); status.replaceChildren();
    if (reviewEvidence) {
      const result = reviewEvidence;
      status.append(document.createTextNode(state.variant.vlm
        ? `VLM experiment: removed edges ${result.removed}; retained ${result.kept}, of which not supported by VLM ${result.unresolved}. `
        : 'Original geometry. A saved VLM experiment is available. '));
      status.append(document.createTextNode(`Checked pairs: ${result.checkedPairs}/${result.possiblePairs}. `));
      const link = document.createElement('a'); link.href = result.href;
      link.textContent = 'Decisions and evidence ↗'; status.append(link);
    } else if (inputGrouping) {
      status.textContent = 'Input grouping selects saved photo groups. Each group has independently estimated cameras and scale.';
    } else {
      status.textContent = 'No saved connection review or recovery branch for this reconstruction.';
    }
  }
  function chooseVariant(next) {
    if (!next || next.id === state.variant.id) return;
    if (state.room) roomSelections.set(`${state.variant.id}:${state.roomSource}:${state.room}`, new Set(state.selected));
    else selections.set(state.variant.id, new Set(state.selected));
    const previousIds = new Set(state.variant.sources.map(source => source.id));
    const sameInputs = next.sources.some(source => previousIds.has(source.id));
    const selection = state.room ? roomSelections.get(`${next.id}:${state.roomSource}:${state.room}`) || state.selected
      : selections.get(next.id) || (sameInputs ? state.selected : next.initial);
    state.variant = next;
    state.selected = new Set([...selection].filter(id => next.sources.some(source => source.id === id)));
    updateControls(); build();
  }
  function variantFor(matcher, model, vlm, recovery = false) {
    const choices = settings.variants.filter(v => v.matcher === matcher && v.model === model);
    return choices.find(v => !!v.vlm === !!vlm && !!v.recovery === !!recovery)
      || choices.find(v => !!v.vlm === !!vlm && !v.recovery) || choices.find(v => !v.vlm)
      || settings.variants.find(v => v.matcher === matcher && !v.vlm);
  }
  get('compare-toggle').onclick = () => {
    state.compare = !state.compare;
    if (state.compare && !state.compareCustom) get('compare-model-choice').open = false;
    comparisonCamera = null; build();
  };
  get('compare-photo').onchange = () => { state.comparePhoto = get('compare-photo').value; comparisonCamera = null; build(); };
  get('vlm').onchange = () => chooseVariant(selectConnections(settings.variants, state.variant, get('vlm').checked, false));
  get('recovery').onchange = () => chooseVariant(selectConnections(settings.variants, state.variant, true, get('recovery').checked));
  const params = new URLSearchParams(location.search);
  if (['matcher', 'model', 'vlm', 'recovery'].some(key => params.has(key))) {
    const recovery = params.has('recovery') ? params.get('recovery') === '1' : state.variant.recovery;
    const vlm = params.has('vlm') ? params.get('vlm') === '1' : params.has('recovery') ? recovery : state.variant.vlm;
    state.variant = variantFor(params.get('matcher') || state.variant.matcher, params.get('model') || state.variant.model, vlm, vlm && recovery) || state.variant;
  }
  if (params.has('variant')) state.variant = settings.variants.find(v => v.id === params.get('variant')) || state.variant;
  updateControls();
  get('all').onclick = () => { state.selected = new Set(state.room ? roomNames() : state.variant.sources.filter(s => !s.reference).map(s => s.id)); draw(); };
  get('none').onclick = () => { state.selected.clear(); draw(); };
  get('detail').onchange = () => { state.limit = Number(get('detail').value); draw(); };
  for (const id of ['point-size', 'cut-height', 'section-center', 'section-width', 'section-azimuth', 'section-tilt']) {
    get(id).oninput = () => { if (get(id).validity.valid) { tools.updateControlLabels(); scheduleDraw(); } };
  }
  for (const id of ['cutaway', 'section', 'section-axis', 'section-guide']) get(id).onchange = () => { tools.updateControlLabels(); draw(); };
  get('projection').onchange = draw;
  get('navigation').onchange = () => {
    if (get('navigation').value === 'explore') explorePhoto();
    else { const view = activeView(); if (view) renderer.navigate(view.plot,'inspect'); syncNavigation(); }
  };
  get('explore-speed').oninput = tools.updateControlLabels;
  get('photo-view').onchange = () => { get('jump-photo').disabled = get('open-view-photo').disabled = !get('photo-view').value; };
  get('jump-photo').onclick = () => explorePhoto(get('photo-view').value);
  get('open-view-photo').onclick = () => {
    const plot = activeView()?.plot; if (plot) plot.dispatchEvent(new CustomEvent('planrec-camera-open',{bubbles:true,detail:{id:get('photo-view').value}}));
  };
  document.addEventListener('planrec-navigation',syncNavigation);
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
  get('reset').onclick = () => { if (state.compare) { comparisonCamera = null; draw(); return; } for (const view of plots.values()) if (view.plot.data) { if (view.plot.dataset.navigation === 'explore') renderer.navigate(view.plot,'inspect'); renderer.relayout(view.plot, {'scene.camera': state.room ? roomCamera : defaultCamera}); } syncNavigation(); };
  for (const button of document.querySelectorAll('[data-orient]')) button.onclick = () => {
    if (state.compare) { const view = activeView(); if (view) renderer.orient(view.plot, button.dataset.orient); return; }
    for (const view of plots.values()) if (view.plot.data) renderer.orient(view.plot, button.dataset.orient);
  };
  get('measure').onchange = () => { if (get('measure').checked) { const view = activeView(); if (view?.plot.dataset.navigation === 'explore') renderer.navigate(view.plot,'inspect'); } renderer.setMeasuring(); tools.updateControlLabels(); };
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
  get('navigation-help').textContent = 'Inspect: drag a ring to rotate around its axis, or drag elsewhere to orbit; Shift/right-drag or two fingers to pan; scroll/pinch to zoom; double-click to focus the pivot. The ring button shows or hides the pivot guide. Escape ends a ring drag. Explore: drag to look; WASD/arrows or the movement pad to move; scroll to move forward/back. F: fit; T: top.';
  state.selected = new Set(state.room ? roomNames() : state.variant.initial);
  if (params.get('photos') === 'all') state.selected = new Set(state.variant.sources.filter(s => !s.reference).map(s => s.id));
  if (params.get('compare') === '1') {
    state.compare = true; state.comparePhoto = params.get('photo');
    state.compareModels = new Set((params.get('models') || '').split(',').filter(Boolean).slice(0, 4));
    state.compareCustom = state.compareModels.size > 0;
  }
  const sceneId = tools.sceneIdentity(settings);
  function captureView() {
    for (const view of plots.values()) if (view.plot.data) {
      cameras.set(view.key, currentCamera(view.plot)); inspections.set(view.key, renderer.inspectionState(view.plot));
    }
    const keys = new Set([...plots.values()].map(v => v.key));
    return {version:1, scene:sceneId, variant:state.variant.id, photos:[...state.selected], limit:state.limit,
      mode:state.mode, room:state.room, roomSource:state.roomSource, controls:tools.readControls(),
      comparison:state.compare ? {photo:state.comparePhoto, models:[...state.compareModels], custom:state.compareCustom, camera:comparisonCamera} : null,
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
    state.compare = !!saved.comparison; state.comparePhoto = saved.comparison?.photo || null;
    state.compareModels = new Set((saved.comparison?.models || []).slice(0, 4));
    const custom = saved.comparison?.custom;
    state.compareCustom = typeof custom === 'boolean' ? custom : state.compareModels.size > 0;
    comparisonCamera = saved.comparison?.camera || null;
    tools.writeControls(saved.controls); get('measure').checked = false; tools.updateControlLabels();
    if (state.variant.relativeScale ?? settings.relativeScale) get('measure-units').value = 'm';
    get('detail').value = String(state.limit);
    for (const [key, value] of Object.entries(saved.cameras)) cameras.set(key, value);
    for (const [key, value] of Object.entries(saved.inspections || {})) inspections.set(key, value);
    updateControls(); updateRoomControls();
  }
  async function restoreView(saved) {
    applyView(saved); build();
    const view = saved.expanded && plots.get(saved.expanded);
    // Open the requested scene before waiting: it may start below the viewport,
    // where lazy loading intentionally keeps its geometry unloaded.
    if (!view) return;
    expandScene(view, view.section.querySelector('.scene-expand'));
    const deadline = performance.now() + 30000;
    while (drawing || !view.plot.data) {
      if (!state.selected.size || !plots.size) return;
      if (performance.now() > deadline) throw new Error('View settings restored, but geometry has not finished loading.');
      await new Promise(requestAnimationFrame);
    }
  }
  tools.setupPanels(); tools.updateControlLabels();
  setupAdjustments({unit:() => coordinateUnit,widthRange:() => Math.max(.1,...['x','y','z'].map(a => { const r = activeView()?.plot.layout?.scene[a+'axis'].range; return r ? r[1]-r[0] : 1; }))});
  const initialView = tools.setupBookmarks({scene:sceneId, capture:captureView, restore:restoreView});
  if (initialView) await restoreView(initialView);
  else { updateRoomControls(); build(); }
})().catch(error => { document.getElementById('loading').textContent = 'Unable to start the 3D viewer. ' + error.message; });

/* Small viewer state/geometry helpers. No inference or network requests. */
export const controlSpec = {
  projection: ['perspective', 'orthographic'], colour: ['rgb', 'source', 'group', 'patch'],
  cameras: true, level: true, axes: false, paths: false, 'room-extra': true,
  'point-size': [1, 5, 2], cutaway: false, 'cut-height': [5, 100, 75],
  section: false, 'section-axis': ['z', 'x', 'y', 'custom'],
  'section-center': [0, 100, 50], 'section-width': [.001, 10000, .3],
  'section-azimuth': [-180, 180, 0], 'section-tilt': [0, 180, 90],
  'section-guide': false, 'measure-units': ['m', 'cm'],
};
export const detailLevels = [0, 1000, 2000, 5000, 10000, 25000, 100000, 250000];
export function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export function sceneIdentity(settings) {
  return hashText(JSON.stringify(settings.variants.map(v => [v.id, v.sources.map(s => [s.id, s.pose, s.chunks.map(c => c.key)])])));
}
export function measureParts(a, b) {
  if (a.frame == null || a.frame !== b.frame) return null;
  const d = a.point.map((v, i) => b.point[i] - v);
  return {distance: Math.hypot(...d), horizontal: Math.hypot(d[0], d[1]), vertical: Math.abs(d[2])};
}
export function sectionNormal(axis, azimuth = 0, tilt = 90) {
  if (axis === 'x') return [1, 0, 0];
  if (axis === 'y') return [0, 1, 0];
  if (axis !== 'custom') return [0, 0, 1];
  const a = azimuth * Math.PI / 180, t = tilt * Math.PI / 180;
  return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)];
}
export function clipping(ranges, values) {
  const planes = [];
  if (values.cutaway) planes.push([0, 0, -1, ranges[2][0] + (ranges[2][1] - ranges[2][0]) * values['cut-height'] / 100]);
  let section = null;
  if (values.section) {
    const normal = sectionNormal(values['section-axis'], values['section-azimuth'], values['section-tilt']);
    const low = normal.reduce((s, n, i) => s + n * ranges[i][n < 0 ? 1 : 0], 0);
    const high = normal.reduce((s, n, i) => s + n * ranges[i][n < 0 ? 0 : 1], 0);
    const center = low + (high - low) * values['section-center'] / 100, width = values['section-width'];
    planes.push([...normal, -center + width / 2], normal.map(n => -n).concat(center + width / 2));
    section = {normal, center, width};
  }
  return {planes, section};
}
export function insideClip(point, planes) {
  return planes.every(p => p[0] * point[0] + p[1] * point[1] + p[2] * point[2] + p[3] >= -1e-7);
}
export function cleanControls(values = {}) {
  return Object.fromEntries(Object.entries(controlSpec).map(([id, spec]) => {
    const value = values[id];
    if (typeof spec === 'boolean') return [id, typeof value === 'boolean' ? value : spec];
    if (typeof spec[0] === 'string') return [id, spec.includes(value) ? value : spec[0]];
    return [id, Number.isFinite(value) ? Math.max(spec[0], Math.min(spec[1], value)) : spec[2]];
  }));
}
export function readControls() {
  return cleanControls(Object.fromEntries(Object.entries(controlSpec).map(([id, spec]) => {
    const el = document.getElementById(id);
    return [id, typeof spec === 'boolean' ? el.checked : typeof spec[0] === 'number' ? Number(el.value) : el.value];
  })));
}
export function writeControls(values) {
  for (const [id, value] of Object.entries(cleanControls(values))) {
    const el = document.getElementById(id);
    if (typeof value === 'boolean') el.checked = value; else el.value = String(value);
  }
  updateControlLabels();
}
export function updateControlLabels() {
  const get = id => document.getElementById(id);
  get('point-size-value').textContent = get('point-size').value + ' px';
  get('cut-height-control').hidden = !get('cutaway').checked;
  get('cut-height-value').textContent = get('cut-height').value + '%';
  get('section-fields').hidden = !get('section').checked;
  get('section-custom').hidden = get('section-axis').value !== 'custom';
  get('section-center-value').textContent = get('section-center').value + '%';
  get('section-panel').classList.toggle('active-tool', get('section').checked || get('cutaway').checked);
  get('measurement-panel').classList.toggle('active-tool', get('measure').checked);
}
const finiteVector = v => v && ['x', 'y', 'z'].every(a => Number.isFinite(v[a]) && Math.abs(v[a]) < 1e8);
export function validCamera(camera) {
  return camera && finiteVector(camera.eye) && finiteVector(camera.center)
    && (camera.scale == null || Number.isFinite(camera.scale) && camera.scale > 0 && camera.scale < 1e8);
}
export function validateBookmark(value, scene) {
  if (!value || value.version !== 1 || value.scene !== scene || typeof value.variant !== 'string'
    || !Array.isArray(value.photos) || value.photos.length > 2000 || !value.photos.every(id => typeof id === 'string')) throw new Error('This saved view belongs to different or unavailable scene data.');
  if (!['points', 'planes', 'both'].includes(value.mode) || !detailLevels.includes(value.limit)) throw new Error('Unsupported saved view settings.');
  if (!value.cameras || Object.keys(value.cameras).length > 1000 || !Object.values(value.cameras).every(validCamera)) throw new Error('Invalid saved camera.');
  return {...value, controls: cleanControls(value.controls)};
}
export function encodeView(value) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeView(text, scene) {
  if (text.length > 120000) throw new Error('The saved-view link is too large.');
  return validateBookmark(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))), scene);
}
export function setupPanels() {
  const panels = [...document.querySelectorAll('.tool-panel')];
  for (const panel of panels) panel.addEventListener('toggle', () => {
    if (panel.open) for (const other of panels) if (other !== panel) other.open = false;
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('#view-controls')) for (const panel of panels) panel.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panels.some(p => p.open)) {
      for (const panel of panels) if (panel.open) { panel.open = false; panel.querySelector('summary').focus(); }
      event.preventDefault(); event.stopPropagation();
    }
  }, true);
}
export function setupBookmarks({scene, capture, restore}) {
  const get = id => document.getElementById(id), key = `planrec-views-v1:${scene}`;
  const status = text => { get('saved-status').textContent = text; };
  let entries = [];
  try { entries = JSON.parse(localStorage.getItem(key) || '[]'); if (!Array.isArray(entries)) entries = []; }
  catch { status('Browser storage is unavailable. Copy a view link instead.'); }
  entries = entries.filter(e => typeof e.name === 'string' && typeof e.id === 'string' && e.state?.scene === scene).slice(0, 40);
  const update = selected => {
    get('saved-views').replaceChildren(new Option('Choose a saved view', ''));
    for (const entry of entries) get('saved-views').add(new Option(entry.name, entry.id));
    get('saved-views').value = selected || '';
    get('load-view').disabled = get('delete-view').disabled = !get('saved-views').value;
  };
  const persist = next => { localStorage.setItem(key, JSON.stringify(next)); entries = next; };
  get('saved-views').onchange = () => update(get('saved-views').value);
  get('save-view').onclick = () => {
    try {
      if (entries.length >= 40) throw new Error('40 saved views reached. Delete an unused view first.');
      const name = get('view-name').value.trim() || `View ${entries.length + 1}`, id = crypto.randomUUID();
      persist([...entries, {name: name.slice(0, 70), id, state: capture()}]); update(id);
      status(`Saved “${name}” in this browser.`);
    } catch (error) { status(`Could not save: ${error.message}`); }
  };
  get('load-view').onclick = async () => {
    try {
      const entry = entries.find(e => e.id === get('saved-views').value);
      if (entry) { await restore(validateBookmark(entry.state, scene)); status(`Restored “${entry.name}”.`); }
    } catch (error) { status(`Could not restore: ${error.message}`); }
  };
  get('delete-view').onclick = () => {
    try { persist(entries.filter(e => e.id !== get('saved-views').value)); update(); status('Saved view deleted.'); }
    catch (error) { status(`Could not delete: ${error.message}`); }
  };
  get('copy-view').onclick = async () => {
    try {
      const encoded = encodeView(capture());
      if (encoded.length > 120000) throw new Error('Too many annotations for a link. Save this view in the browser.');
      const url = new URL(location.href); url.hash = 'view=' + encoded;
      const field = get('view-link'); field.value = url.href; field.hidden = false;
      try { await navigator.clipboard.writeText(url.href); status('View link copied. It includes settings and rulers, not cloud files.'); }
      catch { field.focus(); field.select(); status('Copy the selected view link.'); }
    } catch (error) { status(`Could not create link: ${error.message}`); }
  };
  update();
  addEventListener('hashchange', async () => {
    const text = new URLSearchParams(location.hash.slice(1)).get('view');
    if (!text) return;
    try { await restore(decodeView(text, scene)); status('Restored linked view.'); }
    catch (error) { status(`View link not loaded: ${error.message}`); }
  });
  const encoded = new URLSearchParams(location.hash.slice(1)).get('view');
  if (encoded) {
    try { return decodeView(encoded, scene); }
    catch (error) { status(`View link not loaded: ${error.message}`); }
  }
  return null;
}

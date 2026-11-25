/* Editable measurements are annotations in a known frame, never geometry edits. */
import * as THREE from './vendor/three/three.module.js';
const {measureParts} = await import('./viewer-tools.js' + new URL(import.meta.url).search);
const sets = new Set();
let active;
const get = id => document.getElementById(id);
const format = (n, unit) => unit === 'rel. units' ? `${n.toFixed(2)} rel. units`
  : get('measure-units').value === 'cm' ? `${(n * 100).toFixed(1)} cm` : `${n.toFixed(2)} m`;
function status(text) { get('measure-status').textContent = text; get('measure-status').hidden = !text; }
function destroy(record, view) {
  view.scene.remove(record.group);
  record.group.children.forEach(o => { o.geometry.dispose(); o.material.dispose(); });
  record.label.remove(); record.handles.forEach(h => h.remove());
}
function list() {
  const container = get('measurements-list'); container.replaceChildren();
  for (const set of sets) for (const record of set.records) {
    const row = document.createElement('div'); row.className = 'measurement-row';
    const choose = document.createElement('button'), remove = document.createElement('button');
    const parts = measureParts(...record.picks), name = `Ruler ${set.records.indexOf(record) + 1}`;
    choose.textContent = `${name} · ${format(parts.distance, record.picks[0].unit)}`;
    choose.setAttribute('aria-pressed', active?.record === record);
    choose.onclick = () => set.select(record);
    remove.textContent = '×'; remove.setAttribute('aria-label', `Delete ${name}`);
    remove.onclick = () => set.remove(record);
    row.append(choose, remove); container.append(row);
  }
  get('measurements-empty').hidden = container.childElementCount > 0;
  get('clear-measure').disabled = ![...sets].some(s => s.records.length || s.draft);
}
export function refreshMeasurements() {
  for (const set of sets) set.render();
  if (active) active.set.describe(active.record);
  list();
}
export function clearMeasurements() {
  for (const set of sets) set.clear();
  status(get('measure').checked ? 'Click A, then B in the same connected group.' : '');
}
export function setMeasuring() {
  for (const set of sets) { set.cancel(); set.render(); }
  status(get('measure').checked ? 'Click A, then B to add a ruler. Drag an endpoint to adjust it.' : '');
  list();
}
export function attachRulers(view, pick) {
  const set = {
    view, records: [], draft: null, editing: null,
    item(hit) {
      return {point: hit.point.toArray(), frame: hit.object.userData.frame,
        name: hit.photoLabel, kind: hit.object.isMesh ? 'patch surface' : 'point', unit: hit.object.userData.unit};
    },
    hit(event) {
      const pointsOnly = [...view.objects.values()].some(({object}) => object.isPoints);
      const result = pick(view, event, pointsOnly);
      if (!result) { status(pointsOnly ? 'No visible point here. Click a cloud point.' : 'No visible patch here. Click inside a visible patch.'); return null; }
      return this.item(result);
    },
    create(picks, id = crypto.randomUUID()) {
      const record = {id, picks, group: new THREE.Group(), label: document.createElement('button'), handles: []};
      record.label.className = 'ruler-distance'; record.label.onclick = () => this.select(record);
      view.plot.append(record.label); view.scene.add(record.group);
      for (let i = 0; i < 2; i++) {
        const handle = document.createElement('button'); handle.className = 'ruler-endpoint'; handle.textContent = i ? 'B' : 'A';
        handle.setAttribute('aria-label', `Move endpoint ${i ? 'B' : 'A'}`);
        handle.title = 'Drag onto a surface, or click then choose a new position';
        let down = null, moved = false;
        handle.addEventListener('pointerdown', event => {
          if (event.button !== 0 || !get('measure').checked) return;
          event.preventDefault(); event.stopPropagation(); handle.setPointerCapture(event.pointerId);
          down = [event.clientX, event.clientY]; moved = false; view.controls.enabled = false; this.select(record);
        });
        handle.addEventListener('pointermove', event => {
          if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) < 3 && !moved) return;
          moved = true; const item = this.hit(event);
          if (item) this.replace(record, i, item);
        });
        const finish = event => {
          if (!down) return;
          if (event.type !== 'pointercancel' && !moved) {
            this.editing = {record, index:i}; status(`Choose a new position for ${i ? 'B' : 'A'} in the same connected group. Escape cancels.`);
          }
          down = null; view.controls.enabled = !view.explore?.enabled;
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        };
        handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
        handle.onclick = event => { if (!event.detail) { this.select(record); this.editing = {record,index:i}; status(`Choose a new position for ${i ? 'B' : 'A'}. Escape cancels.`); } };
        view.plot.append(handle); record.handles.push(handle);
      }
      this.draw(record); return record;
    },
    draw(record) {
      record.group.children.slice().forEach(o => { record.group.remove(o); o.geometry.dispose(); o.material.dispose(); });
      const points = record.picks.map(p => new THREE.Vector3(...p.point));
      const material = new THREE.PointsMaterial({color:'#c36321',size:9,sizeAttenuation:false,depthTest:false,depthWrite:false});
      const markers = new THREE.Points(new THREE.BufferGeometry().setFromPoints(points), material); markers.renderOrder = 1001; record.group.add(markers);
      if (points.length === 2) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({color:'#be601e',depthTest:false,depthWrite:false}));
        line.renderOrder = 1000; record.group.add(line);
        record.midpoint = points[0].clone().lerp(points[1], .5);
      }
      view.invalidate(); this.render();
    },
    describe(record) {
      const source = p => `${p.name}${p.kind === 'patch surface' ? ' (patch surface)' : ''}`;
      if (record.picks.length < 2) { status(`A: ${source(record.picks[0])}. Choose B in the same connected group.`); return; }
      const parts = measureParts(...record.picks), unit = record.picks[0].unit;
      status(`${format(parts.distance, unit)}${unit === 'rel. units' ? '' : ' · predicted scale'} · A: ${source(record.picks[0])} · B: ${source(record.picks[1])}`);
      get('measurement-components').textContent = `3D ${format(parts.distance, unit)} · Horizontal ${format(parts.horizontal, unit)} · Vertical ${format(parts.vertical, unit)}. Horizontal/vertical follow the displayed axes.`;
      view.plot.dataset.measuredDistance = String(parts.distance);
      view.plot.dataset.measuredHorizontal = String(parts.horizontal); view.plot.dataset.measuredVertical = String(parts.vertical);
    },
    select(record) {
      if (this.draft && record !== this.draft) this.cancel();
      active = {set:this,record}; this.describe(record);
      for (const set of sets) set.render(); list();
    },
    replace(record, index, item) {
      const other = record.picks[1 - index];
      if (other && measureParts(other, item) === null) { status('Relative placement is unknown. Keep both endpoints in the same connected group.'); return false; }
      record.picks[index] = item; this.draw(record); this.select(record); return true;
    },
    measure(event) {
      if (!this.editing && !this.draft && this.records.length >= 100) { status('100 rulers in this group. Delete an unused ruler before adding another.'); return; }
      const item = this.hit(event); if (!item) return;
      if (this.editing) {
        if (this.replace(this.editing.record, this.editing.index, item)) this.editing = null;
        return;
      }
      // A draft cannot span separate scene canvases.
      for (const other of sets) if (other !== this) other.cancel();
      if (!this.draft) this.draft = this.create([item]);
      else {
        if (measureParts(this.draft.picks[0], item) === null) { status('Relative placement is unknown between these parts. Choose B in the same connected group as A.'); return; }
        this.draft.picks.push(item); this.draw(this.draft); this.records.push(this.draft);
        const completed = this.draft; this.draft = null; this.select(completed); return;
      }
      this.select(this.draft);
    },
    render() {
      const all = [...this.records, ...(this.draft ? [this.draft] : [])];
      const position = (element, point, visible) => {
        const p = new THREE.Vector3(...point).project(view.camera);
        element.hidden = !visible || p.z < -1 || p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1;
        element.style.left = `${(p.x + 1) * view.plot.clientWidth / 2}px`; element.style.top = `${(1 - p.y) * view.plot.clientHeight / 2}px`;
      };
      for (const record of all) {
        if (record.picks.length === 2) {
          const parts = measureParts(...record.picks); record.label.textContent = format(parts.distance, record.picks[0].unit);
          record.label.setAttribute('aria-pressed', active?.record === record);
          record.label.title = `A: ${record.picks[0].name} · B: ${record.picks[1].name}`;
          position(record.label, record.midpoint.toArray(), true);
        } else record.label.hidden = true;
        record.handles.forEach((h, i) => {
          if (record.picks[i]) position(h, record.picks[i].point, active?.record === record && get('measure').checked);
          else h.hidden = true;
        });
      }
    },
    cancel() {
      const had = !!this.draft || !!this.editing;
      if (this.draft) { if (active?.record === this.draft) active = null; destroy(this.draft, view); this.draft = null; }
      this.editing = null; view.controls.enabled = !view.explore?.enabled; view.invalidate(); list();
      if (had) status(get('measure').checked ? 'Click A, then B to add a ruler.' : '');
      return had;
    },
    remove(record) {
      this.records = this.records.filter(r => r !== record); destroy(record, view);
      if (this.editing?.record === record) this.editing = null;
      if (active?.record === record) { active = null; status(''); get('measurement-components').textContent = ''; }
      delete view.plot.dataset.measuredDistance; view.invalidate(); list();
    },
    clear() {
      this.cancel(); for (const record of this.records.slice()) this.remove(record);
      delete view.plot.dataset.measuredDistance; delete view.plot.dataset.measuredHorizontal; delete view.plot.dataset.measuredVertical;
    },
    snapshot() { return {signature:view.geometrySignature, records:this.records.map(r => ({id:r.id,picks:r.picks}))}; },
    restore(saved) {
      if (!saved || saved.signature !== view.geometrySignature || !Array.isArray(saved.records) || saved.records.length > 100) return;
      const known = new Map([...view.objects.values()].filter(({object}) => object.userData.frame != null).map(({object}) => [object.userData.frame, object.userData.unit]));
      for (const record of saved.records) {
        if (!Array.isArray(record.picks) || record.picks.length !== 2 || record.picks.some(p => !p || !Array.isArray(p.point) || p.point.length !== 3 || !p.point.every(n => Number.isFinite(n) && Math.abs(n) < 1e8) || !known.has(p.frame) || p.unit !== known.get(p.frame) || typeof p.name !== 'string' || p.name.length > 300 || !['m','rel. units'].includes(p.unit)) || measureParts(...record.picks) === null) continue;
        this.records.push(this.create(record.picks));
      }
      if (this.records.length) this.select(this.records.at(-1)); list();
    },
    dispose() { this.clear(); sets.delete(this); list(); },
  };
  sets.add(set); return set;
}

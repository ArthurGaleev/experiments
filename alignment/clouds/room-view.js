/* Pure display helpers. Never write display offsets into reconstructed poses. */
(() => {
  'use strict';
  function parts(components, names) {
    const wanted = new Set(names);
    return components.map(component => ({component, ids: component.ids.filter(id => wanted.has(id))}))
      .filter(part => part.ids.length).sort((a, b) => b.ids.length - a.ids.length || a.component.id.localeCompare(b.component.id));
  }
  function bounds(traces) {
    return ['x', 'y', 'z'].map(axis => {
      let low = Infinity, high = -Infinity;
      for (const trace of traces) for (const n of trace.bounds?.[['x', 'y', 'z'].indexOf(axis)] || trace[axis] || []) {
        if (n === null || !Number.isFinite(n)) continue;
        low = Math.min(low, n); high = Math.max(high, n);
      }
      return low === Infinity ? [0, 1] : [low, Math.max(high, low + .1)];
    });
  }
  function layout(parts) {
    const extents = parts.map(part => bounds(part.data));
    const size = [0, 1, 2].map(axis => Math.max(1, ...extents.map(b => b[axis][1] - b[axis][0])));
    const gap = Math.max(size[0], size[1]) * .35, cols = Math.ceil(Math.sqrt(parts.length || 1));
    const data = [], offsets = [];
    parts.forEach((part, index) => {
      const b = extents[index];
      const offset = [(index % cols) * (size[0] + gap) - b[0][0], Math.floor(index / cols) * (size[1] + gap) - b[1][0], -b[2][0]];
      offsets.push(offset);
      for (const trace of part.data) {
        const shifted = {...trace};
        if (trace.cloud) {
          shifted.cloud = {...trace.cloud, offset: offset.slice()};
          shifted.bounds = trace.bounds.map((b, i) => b.map(v => v + offset[i]));
        }
        if (trace.surface) shifted.surface = {...trace.surface, offset: offset.slice()};
        ['x', 'y', 'z'].forEach((axis, i) => {
          shifted[axis] = Array.from(trace[axis] || [], n => n === null ? null : n + offset[i]);
        });
        // A display coordinate must never be presented as a measured room position.
        shifted.hovertemplate = `${trace.name || ''}<br>${part.label}<br>Relative placement of parts is unknown<extra></extra>`;
        data.push(shifted);
      }
      data.push({type: 'scatter3d', mode: 'text', x: [b[0][0] + offset[0]],
        y: [b[1][0] + offset[1]], z: [b[2][1] + offset[2] + gap * .3],
        text: [part.label], textposition: 'top right', textfont: {size: 13, color: '#8a5513'},
        hoverinfo: 'skip', showlegend: false});
    });
    const ranges = bounds(data).map(([lo, hi]) => [lo - gap * .3, hi + gap * .3]);
    return {data, ranges, offsets};
  }
  window.planrecRoomView = {parts, layout};
})();

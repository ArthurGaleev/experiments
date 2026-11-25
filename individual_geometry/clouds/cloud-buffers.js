/* Lossless point buffers and camera-space transforms; no rendering dependencies. */
export function pointAssetUrl(asset, hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) && asset.localUrl ? asset.localUrl : asset.url;
}
// Display offsets cancel only within one known geometric frame.
export function measurementDistance(a, b) {
  if (a.frame == null || a.frame !== b.frame) return null;
  return Math.hypot(...a.point.map((v, i) => v - b.point[i]));
}

// Offer only detail levels that can change the saved geometry being displayed.
export function detailChoices(sources, requested) {
  const maximum = Math.max(0, ...sources.map(source => source.available || 0));
  const levels = [1000, 2000, 5000, 10000, 25000, 100000, 250000].filter(n => n < maximum);
  return {maximum, levels, selected: requested && requested < maximum ? requested : 0};
}

export function segmentDistance2D(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

export function decodePoints(buffer, expectedCount) {
  if (buffer.byteLength < 8) throw new Error('Truncated point buffer');
  const header = new DataView(buffer);
  const format = header.getUint32(0, true), shared = format === 0x32435250;
  if (format !== 0x31435250 && !shared) throw new Error('Unknown point format');
  const count = header.getUint32(4, true);
  if (count !== expectedCount || buffer.byteLength !== 8 + count * (shared ? 19 : 15)) {
    throw new Error('Point count or buffer length mismatch');
  }
  return {xyz: new Float32Array(buffer, 8, count * 3),
    rgb: new Uint8Array(buffer, 8 + count * (shared ? 16 : 12), count * 3), count,
    ...(shared ? {support: new Uint32Array(buffer, 8 + count * 12, count)} : {})};
}

export function selectedSupport(source, selected) {
  if (!source.supportIds) return null;
  return source.supportIds.reduce((mask, id, index) => selected.has(id) ? (mask | (1 << index)) >>> 0 : mask, 0);
}

export function supportedIndices(support, selected, count) {
  const result = new Uint32Array(count); let length = 0;
  for (let i = 0; i < count; i++) if (support[i] & selected) result[length++] = i;
  return result.subarray(0, length);
}

export function visiblePointCount(source, selected, limit) {
  const count = Math.min(limit || Infinity, source.available), mask = selectedSupport(source, selected);
  if (mask === null) return selected.has(source.id) ? count : 0;
  const counts = source.supportCounts?.[String(count)];
  return counts ? counts.reduce((sum, [bits, n]) => sum + ((bits & mask) ? n : 0), 0) : null;
}

export function cloudMatrix(pose, rotation, offset = [0, 0, 0]) {
  // Column-major layout accepted by Three.js. Includes saved Sim(3) scale.
  const m = new Float64Array(16); m[15] = 1;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
    m[col * 4 + row] = rotation[row].reduce((sum, v, k) => sum + v * pose[k][col], 0)
      + (col === 3 ? offset[row] : 0);
  }
  return m;
}

export function transformedBounds(bounds, pose, rotation, offset = [0, 0, 0]) {
  const m = cloudMatrix(pose, rotation, offset);
  const result = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (let corner = 0; corner < 8; corner++) {
    const p = bounds.map((b, axis) => b[(corner >> axis) & 1]);
    for (let axis = 0; axis < 3; axis++) {
      const v = m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis];
      result[axis][0] = Math.min(result[axis][0], v);
      result[axis][1] = Math.max(result[axis][1], v);
    }
  }
  return result;
}

/* Lossless point buffers and camera-space transforms; no rendering dependencies. */
// Display offsets cancel only within one known geometric frame.
export function measurementDistance(a, b) {
  if (a.frame == null || a.frame !== b.frame) return null;
  return Math.hypot(...a.point.map((v, i) => v - b.point[i]));
}

export function segmentDistance2D(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

export function decodePoints(buffer, expectedCount) {
  if (buffer.byteLength < 8) throw new Error('Truncated point buffer');
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x31435250) throw new Error('Unknown point format');
  const count = header.getUint32(4, true);
  if (count !== expectedCount || buffer.byteLength !== 8 + count * 15) {
    throw new Error('Point count or buffer length mismatch');
  }
  return {xyz: new Float32Array(buffer, 8, count * 3),
    rgb: new Uint8Array(buffer, 8 + count * 12, count * 3), count};
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

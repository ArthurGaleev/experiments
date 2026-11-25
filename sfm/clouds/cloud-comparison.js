/* Compare saved local geometry in the same photo camera frame. No pose fitting. */
export const cameraAxes = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
export const identityPose = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

export function comparisonCandidates(settings, current) {
  let candidates;
  if (!settings.multiview && settings.variants.length === 1) {
    candidates = current.sources.map(source => ({id: source.id, label: source.name,
      sources: [{...source, id: 'single-photo'}]}));
  } else {
    candidates = settings.variants.filter(v => v.matcher === current.matcher
      && !!v.vlm === !!current.vlm && !!v.recovery === !!current.recovery);
  }
  // Changing only saved placement is not a different single-photo depth model.
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = JSON.stringify(candidate.sources.map(source => [source.id, source.chunks.map(c => c.key)])
      .sort((a, b) => a[0].localeCompare(b[0])));
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(candidate => ({...candidate, label:(candidate.label || candidate.model || candidate.id).replace(/ · \d+\/\d+ photos$/, '')}));
}

export function comparisonRanges(sources) {
  const ranges = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (const source of sources) {
    const bounds = [source.bounds[0], source.bounds[2], [-source.bounds[1][1], -source.bounds[1][0]]];
    bounds.forEach((pair, i) => {
      ranges[i][0] = Math.min(ranges[i][0], pair[0]);
      ranges[i][1] = Math.max(ranges[i][1], pair[1]);
    });
  }
  return ranges.map(pair => {
    if (!pair.every(Number.isFinite)) return [-1, 1];
    const pad = Math.max(.05, (pair[1] - pair[0]) * .04);
    return [pair[0] - pad, pair[1] + pad];
  });
}

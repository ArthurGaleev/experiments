import {facets, fields} from './cloud-options.js';
/* Compare saved local geometry in the same photo camera frame. No pose fitting. */
export const cameraAxes = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
export const identityPose = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const fusionResult = variant => variant.controls?.method?.id === 'fusion';

export function comparisonCandidates(settings, current) {
  let candidates;
  if (!settings.multiview && settings.variants.length === 1) {
    candidates = current.sources.map(source => ({id: source.id, label: source.name,
      sources: [{...source, id: 'single-photo'}]}));
  } else {
    candidates = settings.compareAcrossMethods ? settings.variants : settings.variants.filter(v => v.matcher === current.matcher
      && !!v.vlm === !!current.vlm && !!v.recovery === !!current.recovery);
  }
  // A fused surfel can belong to several photos while being stored only once
  // in the scene. Comparison uses its saved per-photo camera-frame projection.
  candidates = candidates.filter(candidate => !candidate.wholeComponentMesh).map(candidate => ({...candidate,
    sources: candidate.sources.map(source => source.comparison ? {...source, ...source.comparison} : source)}));
  // Keep each exact fusion control available for its before/after comparison.
  // Other placement-only changes do not create a different local depth model.
  const representatives = new Map();
  for (const candidate of candidates) {
    const key = fusionResult(candidate) ? `fusion:${candidate.id}`
      : JSON.stringify(candidate.sources.map(source => [source.id, source.chunks.map(c => c.key)])
        .sort((a, b) => a[0].localeCompare(b[0])));
    if (!representatives.has(key) || candidate.id === current.id) representatives.set(key, candidate);
  }
  return [...representatives.values()].map(candidate => {
    const c = facets(candidate);
    const label = settings.compareAcrossMethods ? ['model', 'matcher', 'refinement', 'fusion', 'surface', 'calibration', 'head', 'reference', 'conditioning', 'camera']
      .map(key => key === 'surface' && !candidate.controls?.surface ? null
        : key === 'calibration' && c[key]?.id === 'native' ? null
        : key === 'fusion' && c[key]?.id === 'none' && (!fusionResult(candidate) || candidate.controls?.surface) ? null
        : c[key]?.label).filter(Boolean).join(' · ') : (candidate.label || candidate.model || candidate.id).replace(/ · \d+\/\d+ photos$/, '');
    const connections = fusionResult(candidate) ? candidate.recovery ? ' · VLM review + recovery'
      : candidate.vlm ? ' · VLM review' : ' · Connections off' : '';
    return {...candidate, label: label + connections};
  });
}

export function defaultComparison(candidates, current) {
  const first = candidates.find(candidate => candidate.id === current.id) || candidates[0];
  if (!first) return [];
  const config = facets(first);
  const counterpart = candidates.find(candidate => {
    const options = facets(candidate);
    return (options.surface?.id !== config.surface?.id || options.fusion?.id !== config.fusion?.id)
      && !!candidate.vlm === !!first.vlm && !!candidate.recovery === !!first.recovery
      && fields.every(([key]) => ['fusion', 'surface'].includes(key) || options[key]?.id === config[key]?.id);
  });
  return [first, counterpart || candidates.find(candidate => candidate.id !== first.id)]
    .filter(Boolean).map(candidate => candidate.id);
}

export function comparisonSelection(candidates, current, previous, custom) {
  const available = new Set(candidates.map(candidate => candidate.id));
  const retained = [...previous].filter(id => available.has(id));
  if (custom && retained.length) return {models: retained, custom: true};
  return {models: defaultComparison(candidates, current), custom: false};
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

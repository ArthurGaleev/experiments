/* Choices describe saved results; they never synthesize unrun combinations. */
export const fields = [
  ['method', 'Reconstruction'], ['model', 'Depth / model'], ['matcher', 'Matching'],
  ['refinement', 'Refinement'], ['fusion', 'Fusion'], ['inputGrouping', 'Input grouping'],
  ['surface', 'Surface'], ['calibration', 'Calibration'], ['head', 'Pose head'],
  ['reference', 'Reference photo'], ['conditioning', 'Predicted inputs'], ['camera', 'Cameras'],
];
const choice = (id, label = id) => ({id, label});
const models = {metricanything:'MetricAnything', moge2:'MoGe-2', moge3:'MoGe-3',
  da3metric:'DA3-Metric', da3small:'DA3-Small', da3large11:'DA3-Large 1.1',
  pi3x:'Pi3X', mapanything:'MapAnything', vggt_omega512_mlx:'VGGT-Omega · MLX'};
const matchers = {roma:'RoMa', loma:'LoMa-B', sift:'SIFT'};
const stages = {initial:'Original placement', pair_refit_tree:'Independent pair refits',
  tree_cameras:'Cameras · tree edges', cameras:'Cameras · all edges',
  tree_cameras_scale:'Cameras + scale · tree edges', cameras_scale:'Cameras + scale · all edges'};

export function facets(variant) {
  if (variant.controls) {
    const c = {fusion:choice('none', 'Overlay'), surface:choice('points', 'Points'), ...variant.controls};
    // Fusion changes the saved surface representation, not the estimator that
    // supplied its cameras/depth. Keep those choices beside their source method.
    if (c.method?.id === 'fusion') {
      if (c.model?.id === 'metricanything' && c.matcher?.id === 'roma') {
        c.method = choice('matching', 'Depth + matching');
        c.refinement = choice(c.refinement.id, stages[c.refinement.id] || c.refinement.label);
      } else if (c.model?.id === 'mast3r') {
        c.method = choice('joint_refined', 'Joint reconstruction + refinement');
      }
    }
    if (c.method?.id === 'matching' && !c.calibration) c.calibration = choice('native', 'Model camera');
    return c;
  }
  const key = variant.model || variant.id, label = (variant.label || key).replace(/ · \d+\/\d+ photos$/, '');
  const c = {method:choice('single', 'Single-photo geometry'), model:choice(key, label),
    fusion:choice('none', 'Overlay'), surface:choice('points', 'Points')};
  const model = id => { c.model = choice(id, models[id] || id); };
  if (variant.matcher || /^(roma|loma)_control$/.test(key)) {
    const matcher = variant.matcher || key.split('_')[0];
    c.method = choice('matching', 'Depth + matching'); model(variant.matcher ? key : 'metricanything');
    c.matcher = choice(matcher, variant.matcherLabel || matchers[matcher] || matcher);
    c.refinement = choice('initial', 'Original placement');
  } else if (/^(metricanything|moge2)__/.test(key)) {
    const [depth, stage] = key.split('__'); model(depth);
    if (['native', 'two_view'].includes(stage)) {
      c.method = choice('sfm', 'Structure from motion');
      c.matcher = choice('hloc_sift', 'HLoc SIFT + nearest neighbour');
      c.refinement = choice('colmap', 'COLMAP bundle adjustment');
      c.camera = choice(stage, stage === 'native' ? 'Native track defaults' : 'Keep two-view tracks');
    } else {
      c.method = choice('matching', 'Depth + matching'); c.matcher = choice('roma', 'RoMa');
      c.refinement = choice(stage, stages[stage] || stage);
    }
  } else if (/^(da3small|da3large11)_/.test(key)) {
    const [depth, head, reference] = key.split('_'); model(depth);
    c.method = choice('joint', 'Joint reconstruction');
    c.head = choice(head, head === 'ray' ? 'Ray head' : 'Camera head');
    c.reference = choice(reference, reference === 'first' ? 'First input' : 'Adaptive');
  } else if (/^(pi3x|mapanything)_/.test(key)) {
    const depth = key.split('_')[0]; model(depth);
    const condition = key.slice(depth.length + 1);
    c.method = choice('joint', 'Joint reconstruction');
    const names = {rgb:'RGB only', predicted_k:'Intrinsics', predicted_k_depth:'Intrinsics + depth',
      predicted_k_pose:'Intrinsics + supported poses', predicted_k_depth_pose:'Intrinsics + depth + supported poses',
      k_pose_order_control:'Intrinsics · poses set order only',
      k_depth_pose_order_control:'Intrinsics + depth · poses set order only'};
    c.conditioning = choice(condition, names[condition] || condition);
  } else if (key.startsWith('vggt_omega')) {
    c.method = choice('joint', 'Joint reconstruction'); model('vggt_omega512_mlx');
  } else if (key.startsWith('mast3r_') || key.startsWith('blast3r_')) {
    const blast = key.startsWith('blast3r_'), stage = key.slice(key.indexOf('_') + 1);
    c.method = choice('joint_refined', 'Joint reconstruction + refinement');
    c.model = choice(blast ? 'blast3r' : 'mast3r', blast ? 'BLASt3R' : 'MASt3R-SfM');
    const names = {coarse:'Coarse alignment', refine_depth:'Cameras + dense depth',
      refine_camera_focal:'Cameras + focal length', initial:'Initial predictions',
      camera_only:'Cameras only', camera_focal_scale:'Cameras + focal length + depth scale'};
    c.refinement = choice(stage, names[stage] || stage);
  } else if (key.startsWith('ggpt_')) {
    c.method = choice('joint_refined', 'Joint reconstruction + refinement');
    c.model = choice('ggpt', 'GGPT · VGGT');
    const rest = key.slice(5), camera = rest.startsWith('independent') ? 'independent' : 'shared';
    c.camera = rest === 'initial' ? choice('initial', 'VGGT cameras')
      : choice(camera, camera === 'shared' ? 'Shared intrinsics' : 'Independent intrinsics');
    const stage = rest.replace(/^(native_shared|independent_pinhole)_/, '');
    const names = {initial:'Initial predictions', camera:'Cameras only', aligned:'Aligned original depth', refined:'Point cloud refinement'};
    c.refinement = choice(stage, names[stage] || stage);
  } else if (key === 'moge3' || key === 'moge3_initial') {
    model('moge3'); c.refinement = choice(key === 'moge3' ? 'full' : 'initial',
      key === 'moge3' ? 'Three refinement steps' : 'Before refinement');
  } else if (/^(da3metric|metricanything)_/.test(key)) {
    const [depth, ...calibration] = key.split('_'); model(depth);
    const cal = calibration.join('_');
    c.calibration = choice(cal, {metricanything:'MetricAnything focal', anycalib_pinhole:'AnyCalib pinhole',
      anycalib_edit:'AnyCalib edited camera', reference:'Reference camera (evaluation only)'}[cal] || cal);
  } else if (models[key]) model(key);
  if (['single','matching'].includes(c.method.id) && !c.calibration) c.calibration = choice('native', 'Model camera');
  return c;
}

const equal = (a, b, key) => facets(a)[key]?.id === facets(b)[key]?.id;
export function sameConfiguration(a, b) { return fields.every(([key]) => equal(a, b, key)); }
const surfaceState = (a, b, field) => field !== 'surface'
  || (!!a.vlm === !!b.vlm && !!a.recovery === !!b.recovery
    && fields.every(([key]) => key === 'surface' || equal(a, b, key)));

export function fieldOptions(variants, current, field) {
  const earlier = fields.slice(0, fields.findIndex(([key]) => key === field));
  const candidates = variants.filter(v => surfaceState(v, current, field)
    && earlier.every(([key]) => equal(v, current, key)));
  return new Map(candidates.map(v => facets(v)[field]).filter(Boolean).map(c => [c.id, c.label]));
}

export function selectField(variants, current, field, value) {
  const index = fields.findIndex(([key]) => key === field), earlier = fields.slice(0, index);
  const candidates = variants.filter(v => facets(v)[field]?.id === value
    && surfaceState(v, current, field)
    && earlier.every(([key]) => equal(v, current, key)));
  const score = v => fields.slice(index + 1).reduce((sum, [key], i) => sum + (facets(current)[key] && equal(v, current, key) ? 2 ** (12 - i) : 0), 0)
    + (!!v.vlm === !!current.vlm ? 2 : 0) + (!!v.recovery === !!current.recovery ? 1 : 0)
    + (field === 'surface' && current.controls?.method?.id === 'fusion' && v.controls?.method?.id === 'fusion' ? 2 ** 20 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

export function selectConnections(variants, current, vlm, recovery) {
  const candidates = variants.filter(v => sameConfiguration(v, current));
  return candidates.find(v => !!v.vlm === !!vlm && !!v.recovery === !!recovery)
    || candidates.find(v => !!v.vlm === !!vlm && !v.recovery)
    || candidates.find(v => !v.vlm) || current;
}

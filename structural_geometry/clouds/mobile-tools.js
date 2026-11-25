/* One shared mobile adjustment strip; the original controls remain authoritative. */
export function setupAdjustments({widthRange, unit}) {
  const get = id => document.getElementById(id), strip = get('adjustment-strip'), kind = get('adjustment-kind'), range = get('adjustment-range');
  const labels = {'section-center':'Slice position','section-width':'Slice width','cut-height':'Cutaway height','point-size':'Point size'};
  let dismissed = false, requested = false;
  function sync() {
    const available = [...(get('section').checked ? ['section-center','section-width'] : []), ...(get('cutaway').checked ? ['cut-height'] : []), 'point-size'];
    const selected = available.includes(kind.value) ? kind.value : available[0];
    if (Array.from(kind.options, o => o.value).join() !== available.join()) kind.replaceChildren(...available.map(id => new Option(labels[id],id)));
    kind.value = selected;
    strip.hidden = dismissed || !requested && !get('section').checked && !get('cutaway').checked;
    const source = get(selected);
    range.min = source.min; range.max = selected === 'section-width' ? Math.max(Number(source.value), widthRange(), .1) : source.max;
    range.step = selected === 'section-width' ? '.001' : source.step;
    range.value = source.value;
    range.setAttribute('aria-label',labels[selected] + ' adjustment');
    get('adjustment-value').textContent = selected === 'section-width' ? `${Number(source.value).toFixed(2)} ${typeof unit === 'function' ? unit() : unit}` : source.value + (selected === 'point-size' ? ' px' : '%');
  }
  function apply(value) {
    const source = get(kind.value); source.value = value;
    source.dispatchEvent(new Event('input',{bubbles:true})); sync();
  }
  function show(id) {
    if (id === 'section') id = get('section').checked ? 'section-center' : get('cutaway').checked ? 'cut-height' : 'section-center';
    if (id.startsWith('section-') && !get('section').checked) { get('section').checked = true; get('section').dispatchEvent(new Event('change',{bubbles:true})); }
    dismissed = false; requested = true; sync(); kind.value = id; sync();
    for (const panel of document.querySelectorAll('.tool-panel')) panel.open = false;
    if (!document.querySelector('.scene-viewer[open]')) strip.scrollIntoView({block:'nearest'});
    range.focus({preventScroll:true});
  }
  range.addEventListener('input',()=>apply(range.value));
  kind.addEventListener('change',sync);
  get('adjustment-close').onclick = () => { dismissed = true; sync(); };
  get('adjustment-settings').onclick = () => {
    const panel = get(kind.value === 'point-size' ? 'appearance-panel' : 'section-panel'); panel.open = true;
    panel.querySelector('summary').focus({preventScroll:true});
    if (!document.querySelector('.scene-viewer[open]')) panel.scrollIntoView({block:'nearest'});
  };
  for (const [id,sign] of [['adjustment-less',-1],['adjustment-more',1]]) get(id).onclick = () => {
    const step = kind.value === 'section-width' ? .01 : Number(range.step);
    apply(String(Math.max(Number(range.min),Math.min(Number(range.max),Number(range.value) + sign * step))));
  };
  for (const button of document.querySelectorAll('[data-adjust]')) button.onclick = () => show(button.dataset.adjust);
  for (const id of ['section','cutaway']) get(id).addEventListener('change',()=>{ dismissed = false; sync(); });
  document.addEventListener('planrec-controls-updated',sync);
  sync(); return {sync};
}

// =============================================================================
// Plain-language explanations of technical terms. Any element with
// data-term="KEY" (including content rendered later) shows a tooltip on hover,
// keyboard focus or tap.
// =============================================================================

export const TERMS = {
  SAR: ['SAR – Synthetic Aperture Radar',
    'A satellite radar that sends its own microwave signal and records the echo. It works day and night and sees through clouds, which makes it reliable during storms and floods.'],
  NISAR: ['NISAR',
    'NASA–ISRO SAR mission (launched 2025). An L-band radar whose longer wavelength penetrates forest canopy, used here to detect vegetation loss.'],
  backscatter: ['Backscatter',
    'The share of the radar signal that bounces back to the satellite. Forest returns a lot; cleared land and calm water return little, so a drop in backscatter can mean clearing or flooding.'],
  change: ['Change detection',
    'Comparing observations of the same place at different dates to find what changed, rather than judging a single image on its own.'],
  baseline: ['Pre-event baseline',
    'Observations made before the flood (before the event date you set, or the first well-covered observation). Water seen there counts as normal or permanent water; only water that appears later counts as newly inundated.'],
  coverage: ['Valid coverage',
    'The share of your area that the satellite actually observed on that date. Pixels with no data, cloud, cloud shadow, snow, radar layover/shadow or masks are excluded and never counted as water.'],
  confidence: ['Confidence',
    'How much to trust the flood result – separate from how much water was found. It depends on valid coverage, whether a pre-event baseline exists, and whether an independent sensor agrees. “Insufficient data” means no conclusion can be drawn.'],
  categorical: ['Categorical classes',
    'Each pixel is put in a category (not water, open water, partial water, inundated vegetation). Categories are not an intensity scale: “partial surface water” does not mean “moderate flooding”.'],
  partial: ['Partial surface water',
    'A 30 m pixel that is only partly covered by water, e.g. a shoreline or a flooded field with crops sticking out.'],
  inundated: ['Inundated vegetation',
    'Water beneath a vegetation canopy (flooded forest or crops). Radar can detect it because of a strong double-bounce echo; optical sensors usually cannot.'],
  DSWx: ['OPERA DSWx',
    'Dynamic Surface Water Extent: NASA JPL OPERA maps of surface water at 30 m, from Sentinel-1 radar (DSWx-S1) or Landsat/Sentinel-2 optical imagery (DSWx-HLS).'],
  HLS: ['HLS',
    'Harmonized Landsat Sentinel-2: NASA combines Landsat 8/9 and Sentinel-2 into one consistent 30 m optical record, giving an observation every 2–3 days when skies are clear.'],
  IMERG: ['GPM IMERG',
    'NASA’s Integrated Multi-satellitE Retrievals for GPM: global rainfall estimates every 30 minutes. Used as context – heavy rain makes a flood plausible but does not prove it.'],
  CMR: ['NASA CMR',
    'Common Metadata Repository: NASA’s catalogue of every satellite file. The app asks it which acquisitions actually exist over your area.'],
  GIBS: ['NASA GIBS',
    'Global Imagery Browse Services: NASA’s map imagery of its science products. The app reads its pixels using NASA’s published colour tables.'],
  AOI: ['Area of interest (AOI)',
    'The area you want analysed. One point makes a circle, two points a rectangle, three or more a polygon.'],
  eventconf: ['Date confidence',
    'How well the observations pin down WHEN the event happened. High: the start lies in a window of a week or less, the end was observed, and two or more sources saw it. Low: the start or end is not bounded by any observation.'],
  intensity: ['Intensity levels',
    'For vegetation loss, fire and chlorophyll the app groups NASA’s classes into Low / Moderate / High / Severe. Floods are not given a severity – see Confidence instead.']
};

let tip = null, owner = null;

export function initTerms() {
  tip = document.createElement('div');
  tip.className = 'term-tip';
  tip.id = 'term-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  const find = e => e.target.closest && e.target.closest('[data-term]');
  document.addEventListener('mouseover', e => { const t = find(e); if (t) show(t); });
  document.addEventListener('mouseout', e => { const t = find(e); if (t && !t.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', e => { const t = find(e); if (t) show(t); });
  document.addEventListener('focusout', e => { if (find(e)) hide(); });
  document.addEventListener('click', e => { const t = find(e); if (t) { e.preventDefault(); owner === t && !tip.hidden ? hide() : show(t); } else hide(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
}

function show(el) {
  const t = TERMS[el.dataset.term];
  if (!t) return;
  owner = el;
  tip.innerHTML = `<b>${t[0]}</b><span>${t[1]}</span>`;
  tip.hidden = false;
  el.setAttribute('aria-describedby', 'term-tip');
  const r = el.getBoundingClientRect();
  const w = Math.min(300, innerWidth - 24);
  tip.style.width = `${w}px`;
  const h = tip.offsetHeight;
  let left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hide() {
  if (!tip) return;
  tip.hidden = true;
  if (owner) owner.removeAttribute('aria-describedby');
  owner = null;
}

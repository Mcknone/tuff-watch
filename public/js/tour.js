// =============================================================================
// Guided tour: highlights real interface elements one step at a time.
// Started only from the "How to use EarthScope" button; never automatically.
// =============================================================================

let steps = [];
let idx = 0;
let root = null, spot = null, card = null, lastFocus = null;
let hooks = {};

/**
 * steps: [{ title, body (HTML), target: () => Element|null, before?: () => void }]
 * hooks.reveal(panelId) – make sure a panel is expanded before highlighting it.
 */
export function initTour(stepList, opts = {}) {
  steps = stepList;
  hooks = opts;
}

export function startTour() {
  if (root) endTour();
  lastFocus = document.activeElement;
  root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `
    <div class="tour-backdrop"></div>
    <div class="tour-spot" aria-hidden="true"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      <div class="tour-progress"><span class="tour-count"></span><span class="tour-dots" aria-hidden="true"></span></div>
      <h2 id="tour-title"></h2>
      <div id="tour-body" class="tour-body"></div>
      <div class="tour-actions">
        <button type="button" class="btn-link tour-skip">Skip tour</button>
        <span class="spacer"></span>
        <button type="button" class="btn tour-prev">Previous</button>
        <button type="button" class="btn btn-primary tour-next">Next</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  spot = root.querySelector('.tour-spot');
  card = root.querySelector('.tour-card');
  root.querySelector('.tour-skip').addEventListener('click', endTour);
  root.querySelector('.tour-prev').addEventListener('click', () => go(idx - 1));
  root.querySelector('.tour-next').addEventListener('click', () => (idx >= steps.length - 1 ? endTour() : go(idx + 1)));
  root.querySelector('.tour-backdrop').addEventListener('click', () => card.querySelector('.tour-next').focus());
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.body.classList.add('tour-open');
  go(0);
}

export function endTour() {
  if (!root) return;
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  document.removeEventListener('keydown', onKey, true);
  root.remove();
  root = null;
  document.body.classList.remove('tour-open');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); endTour(); return; }
  if (e.key === 'ArrowRight' && idx < steps.length - 1) { e.preventDefault(); go(idx + 1); return; }
  if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); go(idx - 1); return; }
  if (e.key === 'Tab') {                         // keep focus inside the dialog
    const f = [...card.querySelectorAll('button:not([disabled]):not([hidden])')];
    const i = f.indexOf(document.activeElement);
    if (i < 0) { e.preventDefault(); f[0].focus(); return; }
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
}

function go(i) {
  idx = Math.max(0, Math.min(i, steps.length - 1));
  const s = steps[idx];
  if (s.before) s.before();
  const last = idx === steps.length - 1;
  card.querySelector('#tour-title').textContent = s.title;
  card.querySelector('#tour-body').innerHTML = s.body;
  card.querySelector('.tour-count').textContent = `Step ${idx + 1} of ${steps.length}`;
  card.querySelector('.tour-dots').innerHTML = steps.map((_, k) => `<i class="${k === idx ? 'on' : k < idx ? 'done' : ''}"></i>`).join('');
  const prev = card.querySelector('.tour-prev');
  prev.disabled = idx === 0;
  const next = card.querySelector('.tour-next');
  next.textContent = last ? 'Start exploring' : 'Next';
  card.querySelector('.tour-skip').hidden = last;
  const el = target();
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  requestAnimationFrame(() => { place(); next.focus(); });
}

function target() {
  const s = steps[idx];
  const el = s && s.target ? s.target() : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

function place() {
  if (!root) return;
  const el = target();
  const vw = innerWidth, vh = innerHeight, pad = 6, gap = 12;
  const narrow = vw < 640;
  card.style.maxWidth = narrow ? `${vw - 24}px` : '380px';
  if (!el) {
    spot.style.display = 'none';
    root.querySelector('.tour-backdrop').classList.add('solid');
    card.classList.add('centered');
    card.style.left = card.style.top = '';
    return;
  }
  root.querySelector('.tour-backdrop').classList.remove('solid');
  card.classList.remove('centered');
  const r = el.getBoundingClientRect();
  const R = {
    left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad),
    right: Math.min(vw - 4, r.right + pad), bottom: Math.min(vh - 4, r.bottom + pad)
  };
  Object.assign(spot.style, {
    display: 'block', left: `${R.left}px`, top: `${R.top}px`,
    width: `${R.right - R.left}px`, height: `${R.bottom - R.top}px`
  });
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let left, top;
  if (narrow) {
    left = 12;
    top = R.bottom + gap + ch < vh ? R.bottom + gap : R.top - gap - ch >= 0 ? R.top - gap - ch : vh - ch - 12;
  } else if (R.right + gap + cw < vw) { left = R.right + gap; top = R.top; }
  else if (R.left - gap - cw > 0) { left = R.left - gap - cw; top = R.top; }
  else if (R.bottom + gap + ch < vh) { left = R.left; top = R.bottom + gap; }
  else if (R.top - gap - ch > 0) { left = R.left; top = R.top - gap - ch; }
  else { left = vw - cw - 16; top = vh - ch - 16; }      // target fills the screen: corner
  card.style.left = `${Math.max(8, Math.min(left, vw - cw - 8))}px`;
  card.style.top = `${Math.max(8, Math.min(top, vh - ch - 8))}px`;
}

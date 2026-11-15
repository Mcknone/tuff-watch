// =============================================================================
// Dockable panels: drag a panel by its title bar to the left, right, top or
// bottom of the map; resize docks by dragging their inner edge; collapse a
// panel with "–". The layout is remembered in this browser.
// =============================================================================

const STORE_KEY = 'esm-layout-v1';
const SIDES = ['left', 'right', 'top', 'bottom'];
const SIDE_LABEL = { left: '◧ Left of map', right: '◨ Right of map', top: '⬒ Above map', bottom: '⬓ Below map' };
const SIZE_VAR = { left: '--w-left', right: '--w-right', top: '--h-top', bottom: '--h-bottom' };
const DEFAULT_SIZE = { left: 310, right: 340, top: 220, bottom: 220 };

const layout = document.getElementById('layout');
const dock = side => document.getElementById(`dock-${side}`);
const panels = () => [...layout.querySelectorAll('.panel')];
const sideOf = panel => panel.parentElement.dataset.side;

let onChange = () => {};

/** Set up dragging/resizing. `changed` is called after any layout change. */
export function initLayout(changed) {
  onChange = changed || onChange;
  restore();
  panels().forEach(wirePanel);
  layout.querySelectorAll('.resizer').forEach(wireResizer);
  document.getElementById('reset-layout').addEventListener('click', reset);
  refresh(false);
}

// --------------------------------------------------------------- persistence
function save() {
  const state = { panels: {}, sizes: {} };
  for (const side of SIDES) {
    [...dock(side).querySelectorAll(':scope > .panel')].forEach((p, i) => {
      state.panels[p.dataset.panel] = { side, order: i, collapsed: p.classList.contains('collapsed') };
    });
    const v = layout.style.getPropertyValue(SIZE_VAR[side]);
    if (v) state.sizes[side] = parseInt(v, 10);
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function restore() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { state = null; }
  if (!state || !state.panels) return;
  const entries = panels()
    .map(p => ({ p, s: state.panels[p.dataset.panel] }))
    .filter(e => e.s && SIDES.includes(e.s.side))
    .sort((a, b) => a.s.order - b.s.order);
  for (const { p, s } of entries) {
    dock(s.side).appendChild(p);
    setCollapsed(p, !!s.collapsed);
  }
  for (const side of SIDES) {
    const v = state.sizes && state.sizes[side];
    if (Number.isFinite(v)) layout.style.setProperty(SIZE_VAR[side], `${v}px`);
  }
}

function reset() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  for (const side of SIDES) layout.style.removeProperty(SIZE_VAR[side]);
  for (const p of panels()) {
    dock(p.dataset.default).appendChild(p);
    setCollapsed(p, false);
  }
  refresh(false);
}

// --------------------------------------------------------------- docks
function refresh(persist = true) {
  for (const side of SIDES) {
    const d = dock(side);
    const ps = [...d.querySelectorAll(':scope > .panel')];
    d.classList.toggle('is-empty', ps.length === 0);
    d.classList.toggle('all-collapsed', ps.length > 0 && ps.every(p => p.classList.contains('collapsed')));
  }
  if (persist) save();
  onChange();
}

function setCollapsed(panel, collapsed) {
  panel.classList.toggle('collapsed', collapsed);
  const btn = panel.querySelector('.p-collapse');
  btn.textContent = collapsed ? '+' : '–';
  btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  btn.setAttribute('aria-expanded', String(!collapsed));
}

function moveTo(panel, side, beforeEl = null) {
  const d = dock(side);
  if (beforeEl && beforeEl.parentElement === d) d.insertBefore(panel, beforeEl);
  else d.appendChild(panel);
  refresh();
}

// --------------------------------------------------------------- panel wiring
function wirePanel(panel) {
  const head = panel.querySelector('.panel-head');
  panel.querySelector('.p-collapse').addEventListener('click', () => {
    setCollapsed(panel, !panel.classList.contains('collapsed'));
    refresh();
  });
  panel.querySelector('.p-move').addEventListener('click', e => openMoveMenu(panel, e.currentTarget));
  head.addEventListener('dblclick', e => {
    if (e.target.closest('button')) return;
    setCollapsed(panel, !panel.classList.contains('collapsed'));
    refresh();
  });
  head.addEventListener('pointerdown', e => startDrag(e, panel, head));
}

// Keyboard / click alternative to dragging.
function openMoveMenu(panel, btn) {
  closeMoveMenu();
  const menu = document.createElement('div');
  menu.className = 'move-menu';
  menu.setAttribute('role', 'menu');
  const cur = sideOf(panel);
  menu.innerHTML = SIDES.map(s =>
    `<button type="button" role="menuitem" data-side="${s}" ${s === cur ? 'aria-current="true"' : ''}>${SIDE_LABEL[s]}</button>`).join('');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
  menu.style.top = `${r.bottom + 4 + mh > innerHeight ? r.top - mh - 4 : r.bottom + 4}px`;
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-side]');
    if (!b) return;
    closeMoveMenu();
    moveTo(panel, b.dataset.side);
    btn.focus();
  });
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { closeMoveMenu(); btn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  menu.querySelector('button').focus();
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  function outside(e) { if (!menu.contains(e.target)) closeMoveMenu(); }
  menu._outside = outside;
}
function closeMoveMenu() {
  const m = document.querySelector('.move-menu');
  if (!m) return;
  document.removeEventListener('pointerdown', m._outside, true);
  m.remove();
}

// --------------------------------------------------------------- drag to dock
function startDrag(e, panel, head) {
  if (e.button !== 0 || e.target.closest('button')) return;
  if (matchMedia('(max-width: 820px)').matches) return;     // stacked phone layout
  const x0 = e.clientX, y0 = e.clientY;
  let active = false, target = null;
  const preview = layout.querySelector('.drop-preview');
  const ghost = layout.querySelector('.drop-ghost');
  head.setPointerCapture(e.pointerId);

  const move = ev => {
    if (!active) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      active = true;
      layout.classList.add('dragging');
      panel.classList.add('dragging-src');
      ghost.textContent = `Move “${panel.querySelector('h2').textContent}”`;
    }
    const L = layout.getBoundingClientRect();
    const x = ev.clientX - L.left, y = ev.clientY - L.top;
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    target = pickTarget(x, y, L, panel);
    Object.assign(preview.style, target.rect);
  };
  const end = ev => {
    head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', end);
    head.removeEventListener('pointercancel', end);
    if (head.hasPointerCapture(ev.pointerId)) head.releasePointerCapture(ev.pointerId);
    if (!active) return;
    layout.classList.remove('dragging');
    panel.classList.remove('dragging-src');
    if (ev.type === 'pointerup' && target) moveTo(panel, target.side, target.before);
  };
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

/** Nearest edge of the layout to the pointer = side to dock to. */
function pickTarget(x, y, L, panel) {
  const W = L.width, H = L.height;
  const dist = { left: x / W, right: (W - x) / W, top: y / H, bottom: (H - y) / H };
  const side = SIDES.reduce((a, b) => (dist[b] < dist[a] ? b : a));
  const d = dock(side);
  const vertical = side === 'left' || side === 'right';
  // where in the dock: before the first sibling whose centre is past the pointer
  const sibs = [...d.querySelectorAll(':scope > .panel')].filter(p => p !== panel);
  let before = null;
  for (const s of sibs) {
    const r = s.getBoundingClientRect();
    const mid = vertical ? r.top + r.height / 2 - L.top : r.left + r.width / 2 - L.left;
    if ((vertical ? y : x) < mid) { before = s; break; }
  }
  // preview rectangle: the dock's area (or where a new dock would appear)
  const cs = getComputedStyle(layout);
  const size = parseInt(cs.getPropertyValue(SIZE_VAR[side]), 10) || DEFAULT_SIZE[side];
  const map = document.getElementById('map-wrap').getBoundingClientRect();
  const mx = map.left - L.left, my = map.top - L.top;
  let rect;
  if (side === 'left') rect = { left: '0px', top: '0px', width: `${Math.max(size, mx)}px`, height: `${H}px` };
  else if (side === 'right') { const w = Math.max(size, W - (mx + map.width)); rect = { left: `${W - w}px`, top: '0px', width: `${w}px`, height: `${H}px` }; }
  else if (side === 'top') rect = { left: `${mx}px`, top: '0px', width: `${map.width}px`, height: `${Math.max(Math.min(size, H / 2), my)}px` };
  else { const h = Math.max(Math.min(size, H / 2), H - (my + map.height)); rect = { left: `${mx}px`, top: `${H - h}px`, width: `${map.width}px`, height: `${h}px` }; }
  return { side, before, rect };
}

// --------------------------------------------------------------- resizing
function wireResizer(handle) {
  const side = handle.dataset.side;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    const d = dock(side).getBoundingClientRect();
    const L = layout.getBoundingClientRect();
    const start = side === 'left' || side === 'right' ? d.width : d.height;
    const x0 = e.clientX, y0 = e.clientY;
    const move = ev => {
      let v;
      if (side === 'left') v = start + (ev.clientX - x0);
      else if (side === 'right') v = start - (ev.clientX - x0);
      else if (side === 'top') v = start + (ev.clientY - y0);
      else v = start - (ev.clientY - y0);
      const max = side === 'left' || side === 'right' ? L.width * 0.45 : L.height * 0.65;
      v = Math.round(Math.max(side === 'left' || side === 'right' ? 220 : 120, Math.min(max, v)));
      layout.style.setProperty(SIZE_VAR[side], `${v}px`);
      onChange();
    };
    const up = ev => {
      handle.classList.remove('active');
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    layout.style.removeProperty(SIZE_VAR[side]);
    save();
    onChange();
  });
}

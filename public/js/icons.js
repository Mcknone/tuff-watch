// =============================================================================
// Small line icons (inline SVG, 24×24, stroke = currentColor) drawn for EarthScope.
// icon('water') → '<svg …>'; elements with data-icon="water" are filled by hydrateIcons().
// =============================================================================
const P = {
  plant: '<path d="M12 21v-9"/><path d="M12 12c0-4.4 3.2-7.5 8-7.5 0 4.4-3.2 7.5-8 7.5z"/><path d="M12 15c0-3.3-2.6-5.8-7-5.8 0 3.3 2.6 5.8 7 5.8z"/>',
  water: '<path d="M12 3s-4 4.4-4 7a4 4 0 0 0 8 0c0-2.6-4-7-4-7z"/><path d="M2 17c2.5 0 2.5-1.8 5-1.8s2.5 1.8 5 1.8 2.5-1.8 5-1.8 2.5 1.8 5 1.8"/><path d="M2 21c2.5 0 2.5-1.8 5-1.8s2.5 1.8 5 1.8 2.5-1.8 5-1.8 2.5 1.8 5 1.8"/>',
  fire: '<path d="M12 22c3.9 0 7-2.7 7-6.8 0-4.4-3.8-6.8-4.8-10.7-1.9 2.4-2.4 4.4-1.9 6.3-1.5-.9-2.9-1.9-3.4-3.8C6.4 9.4 5 12 5 15.2 5 19.3 8.1 22 12 22z"/><path d="M12 22c-1.7 0-3-1.2-3-3 0-1.9 1.6-3 2.2-4.6.9 1 3.8 2.5 3.8 4.6 0 1.8-1.3 3-3 3z"/>',
  algae: '<circle cx="12" cy="12" r="5"/><circle cx="10.5" cy="11" r="1"/><circle cx="13.5" cy="13.5" r="1"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.8 2.8M15.9 15.9l2.8 2.8M18.7 5.3l-2.8 2.8M8.1 15.9l-2.8 2.8"/>',
  pin: '<path d="M12 21.5s7-6.4 7-11.8a7 7 0 0 0-14 0c0 5.4 7 11.8 7 11.8z"/><circle cx="12" cy="9.7" r="2.6"/>',
  satellite: '<path d="M13 7 9 3 5 7l4 4"/><path d="m17 11 4 4-4 4-4-4"/><path d="m8 12 4 4 6-6-4-4z"/><path d="m16 8 3-3"/><path d="M9 21a6 6 0 0 0-6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17.2v.1"/>',
  simple: '<path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  detail: '<path d="M9 3h6"/><path d="M10 3v6L4.6 18.6A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.4-2.4L14 9V3"/><path d="M7.2 15h9.6"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16.2 9.5"/>',
  alert: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5M12 17.4v.1"/>',
  refresh: '<path d="M20 11.5a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  resize: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9" stroke-dasharray="2.5 2.5"/>'
};

export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
}

// =============================================================================
// Event detection from real observations (pure functions – no DOM, unit-tested)
//
// An "event" is the period in which the analysed satellite observations show a
// phenomenon (new flood water, active fire, vegetation loss, high chlorophyll).
// Dates are never invented: every boundary is a WINDOW between two real
// observations, e.g. onset = (last clear observation, first affected observation].
// When the observations cannot bound a date, the boundary is left open.
// =============================================================================

const DAY = 86400000;
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * Merge observations made on the same date by different sources.
 * A date is "affected" if any valid source saw the phenomenon there, "clear" if at
 * least one valid source looked and none saw it, otherwise "unknown".
 * obs: [{ date, source, state: 'affected'|'clear'|'unknown', value, coveragePct? }]
 */
export function mergeByDate(obs) {
  const byDate = new Map();
  for (const o of obs) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => {
    const aff = list.filter(o => o.state === 'affected');
    const clear = list.filter(o => o.state === 'clear');
    const state = aff.length ? 'affected' : clear.length ? 'clear' : 'unknown';
    const best = aff.length ? aff.reduce((a, b) => (b.value > a.value ? b : a)) : null;
    return {
      date, state, value: best ? best.value : 0,
      source: best ? best.source : (clear[0] || list[0]).source,
      sources: [...new Set(list.map(o => o.source))],
      affectedSources: [...new Set(aff.map(o => o.source))],
      conflict: aff.length > 0 && clear.length > 0,
      list
    };
  });
}

/**
 * Detect one event in a merged observation series.
 * opts: { kind: 'flood'|'fire'|'change', periodStart, periodEnd, unit, recession: bool }
 * Returns an event object (see README / exported JSON) – status:
 *   'detected'      onset and end both bounded by observations
 *   'ongoing'       onset seen, no clear observation afterwards (end unknown)
 *   'insufficient'  observations exist but none can tell (no baseline, low coverage)
 *   'none'          valid observations, phenomenon never seen
 *   'no-data'       no observations at all
 */
export function detectEvent(series, opts) {
  const { kind = 'change', periodStart, periodEnd, unit = 'km²' } = opts;
  const ev = {
    kind, status: 'no-data', unit, periodStart, periodEnd,
    onset: null, peak: null, recession: null, end: null, band: null,
    firstAffected: null, lastAffected: null, lastClearBefore: null, firstClearAfter: null,
    intermittent: false, confidence: 'Insufficient data', confidenceReasons: [],
    method: '', observations: series.map(o => ({ date: o.date, state: o.state, value: o.value, sources: o.sources, conflict: o.conflict }))
  };
  if (!series.length) {
    ev.confidenceReasons.push('no usable observation in the selected period');
    ev.method = 'No observations to estimate dates from.';
    return ev;
  }
  const affected = series.filter(o => o.state === 'affected');
  if (!affected.length) {
    const known = series.filter(o => o.state === 'clear');
    if (!known.length) {
      ev.status = 'insufficient';
      ev.band = { start: series[0].date, end: series.at(-1).date, openStart: false, openEnd: false, uncertainOnly: true };
      ev.confidenceReasons.push(`${series.length} observation(s), none able to show whether the phenomenon was present (no baseline or too little valid coverage)`);
      ev.method = 'No dates estimated: observations could not distinguish affected from unaffected conditions.';
    } else {
      ev.status = 'none';
      ev.confidence = known.length >= 3 ? 'Medium' : 'Low';
      ev.confidenceReasons.push(`${known.length} valid observation(s), none affected`);
      ev.method = 'No event: the phenomenon was not detected in any valid observation.';
    }
    return ev;
  }

  const first = affected[0], last = affected.at(-1);
  const prevClear = series.filter(o => o.state === 'clear' && o.date < first.date).at(-1) || null;
  const nextClear = series.find(o => o.state === 'clear' && o.date > last.date) || null;
  ev.firstAffected = first.date;
  ev.lastAffected = last.date;
  ev.lastClearBefore = prevClear ? prevClear.date : null;
  ev.firstClearAfter = nextClear ? nextClear.date : null;
  ev.intermittent = series.some(o => o.state === 'clear' && o.date > first.date && o.date < last.date);

  // onset window: (last clear observation, first affected observation]
  ev.onset = {
    earliest: prevClear ? prevClear.date : null,             // null = not bounded by any observation
    latest: first.date,
    windowDays: prevClear ? daysBetween(prevClear.date, first.date) : null,
    basis: prevClear
      ? `between the last ${kind === 'fire' ? 'observation without detections' : 'unaffected observation'} (${prevClear.date}) and the first ${kindWord(kind)} observation (${first.date})`
      : `on or before ${first.date} – no earlier unaffected observation in the period, so the start is not bounded`
  };
  // peak observed value
  const peak = affected.reduce((a, b) => (b.value > a.value ? b : a));
  ev.peak = { date: peak.date, value: peak.value, unit, source: peak.source, sources: peak.affectedSources,
    note: affected.length === 1 ? 'only one affected observation' : 'highest value among observations, not necessarily the true peak' };
  // recession (floods): first later observation that fell below half the peak
  if (opts.recession) {
    const rec = series.find(o => o.date > peak.date && (o.state === 'clear' || (o.state === 'affected' && o.value <= 0.5 * peak.value)));
    if (rec) ev.recession = { date: rec.date, value: rec.state === 'clear' ? 0 : rec.value, basis: rec.state === 'clear' ? 'no new water observed' : 'observed extent fell below half of the peak' };
  }
  // end window: (last affected observation, first clear observation after it]
  ev.end = nextClear
    ? { earliest: last.date, latest: nextClear.date, windowDays: daysBetween(last.date, nextClear.date),
        basis: `between the last ${kindWord(kind)} observation (${last.date}) and the first later ${kind === 'fire' ? 'observation without detections' : 'unaffected observation'} (${nextClear.date})` }
    : null;
  ev.status = nextClear ? 'detected' : 'ongoing';
  ev.band = {
    start: prevClear ? prevClear.date : periodStart, coreStart: first.date,
    coreEnd: last.date, end: nextClear ? nextClear.date : periodEnd,
    openStart: !prevClear, openEnd: !nextClear
  };

  // confidence in the DATES (not in the amount)
  const reasons = [];
  let score = 0;
  if (prevClear) {
    reasons.push(`onset bounded to a ${ev.onset.windowDays}-day window`);
    score += ev.onset.windowDays <= 7 ? 2 : ev.onset.windowDays <= 16 ? 1 : 0;
  } else reasons.push('onset not bounded (no earlier unaffected observation)');
  if (nextClear) { reasons.push(`end bounded to a ${ev.end.windowDays}-day window`); score += 1; }
  else reasons.push('no later unaffected observation – end unknown');
  reasons.push(`${affected.length} affected observation(s)`);
  if (affected.length >= 2) score += 1;
  const multi = new Set(affected.flatMap(o => o.affectedSources)).size;
  if (multi >= 2) { reasons.push(`seen by ${multi} independent sources`); score += 1; }
  if (series.some(o => o.conflict)) { reasons.push('sources disagree on some dates'); score -= 1; }
  if (ev.intermittent) reasons.push('phenomenon absent on some dates in between (gaps or clouds)');
  ev.confidence = score >= 4 ? 'High' : score >= 2 ? 'Medium' : 'Low';
  ev.confidenceReasons = reasons;
  ev.method = [
    'Dates are windows between real observations, never single invented days.',
    `Onset: ${ev.onset.basis}.`,
    `Peak: ${ev.peak.note} (${peak.date}).`,
    ev.end ? `End: ${ev.end.basis}.` : 'End: not observed before the end of the period.',
    kind === 'fire' ? 'Satellite detections are not containment: clouds, smoke and overpass timing can hide active fire.' : ''
  ].filter(Boolean).join(' ');
  return ev;
}

function kindWord(kind) {
  return kind === 'flood' ? 'newly inundated' : kind === 'fire' ? 'active-fire' : 'affected';
}

/**
 * Phase of a date relative to an event: 'before' | 'during' | 'after' | 'uncertain' | null.
 *  before    – on/before the last observation that showed no event
 *  during    – from the first to the last affected observation
 *  after     – on/after the first observation that showed the event over
 *  uncertain – inside an onset/end window, or past the last observation of an event whose end was not observed
 */
export function phaseOf(ev, date) {
  if (!ev || !ev.firstAffected || !date) return null;
  if (date >= ev.firstAffected && date <= ev.lastAffected) return 'during';
  if (date < ev.firstAffected) return ev.lastClearBefore && date <= ev.lastClearBefore ? 'before' : 'uncertain';
  return ev.firstClearAfter && date >= ev.firstClearAfter ? 'after' : 'uncertain';
}

/**
 * Target dates for before / during / after navigation (only real observation dates).
 * dates: sorted analysed dates available on the timeline.
 */
export function phaseTargets(ev, dates) {
  if (!ev || !ev.firstAffected) return { before: null, during: null, after: null };
  // only this event's own observations count – a later image of another phenomenon says nothing about it
  const own = new Set((ev.observations || []).map(o => o.date));
  const ok = d => d && dates.includes(d) && (!own.size || own.has(d));
  const before = ok(ev.lastClearBefore) ? ev.lastClearBefore
    : dates.filter(d => d < ev.firstAffected && (!own.size || own.has(d))).at(-1) || null;
  const during = ok(ev.peak && ev.peak.date) ? ev.peak.date : ok(ev.firstAffected) ? ev.firstAffected : null;
  const after = ok(ev.firstClearAfter) ? ev.firstClearAfter : null;     // no "after" while the event may be ongoing
  return { before, during, after };
}

/** Documented records (reported start, containment…) that fall inside the period. */
export function recordsInPeriod(records, start, end) {
  return (records || []).filter(r => r.date >= start && r.date <= end);
}

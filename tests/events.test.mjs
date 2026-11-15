import assert from 'node:assert/strict';
import { mergeByDate, detectEvent, phaseOf, phaseTargets, recordsInPeriod, daysBetween } from '../public/js/events.js';

const o = (date, state, value = 0, source = 'A') => ({ date, state, value, source });
const opts = { kind: 'flood', periodStart: '2025-08-01', periodEnd: '2025-09-30', recession: true };

// --- flood with bounded onset, peak, recession and end -------------------------
const flood = mergeByDate([
  o('2025-08-02', 'clear'), o('2025-08-10', 'clear'),
  o('2025-08-14', 'affected', 30), o('2025-08-14', 'affected', 25, 'B'),
  o('2025-08-20', 'affected', 80), o('2025-08-26', 'affected', 30),
  o('2025-09-03', 'clear'), o('2025-09-12', 'clear')
]);
const ev = detectEvent(flood, opts);
assert.equal(ev.status, 'detected');
// onset is a WINDOW between the last dry and the first flooded observation – no invented day
assert.deepEqual([ev.onset.earliest, ev.onset.latest, ev.onset.windowDays], ['2025-08-10', '2025-08-14', 4]);
assert.equal(ev.lastClearBefore, '2025-08-10');
assert.equal(ev.firstAffected, '2025-08-14');
assert.equal(ev.peak.date, '2025-08-20'); assert.equal(ev.peak.value, 80);
assert.equal(ev.recession.date, '2025-08-26');          // fell below half the peak
assert.deepEqual([ev.end.earliest, ev.end.latest], ['2025-08-26', '2025-09-03']);
assert.deepEqual(ev.band, { start: '2025-08-10', coreStart: '2025-08-14', coreEnd: '2025-08-26', end: '2025-09-03', openStart: false, openEnd: false });
assert.equal(ev.confidence, 'High');                     // 4-day onset window, end seen, 2 sources
assert.match(ev.method, /windows between real observations/);
assert.equal(flood.find(x => x.date === '2025-08-14').affectedSources.length, 2);

// --- no earlier dry observation: onset is open, never back-dated -------------------
const open = detectEvent(mergeByDate([o('2025-08-05', 'affected', 10), o('2025-08-12', 'affected', 12)]), opts);
assert.equal(open.status, 'ongoing');
assert.equal(open.onset.earliest, null);
assert.equal(open.end, null);
assert.equal(open.band.openStart, true); assert.equal(open.band.openEnd, true);
assert.equal(open.band.start, '2025-08-01'); assert.equal(open.band.end, '2025-09-30');
assert.equal(open.confidence, 'Low');

// --- insufficient evidence: no dates are estimated -------------------------------
const unk = detectEvent(mergeByDate([o('2025-08-05', 'unknown'), o('2025-08-20', 'unknown')]), opts);
assert.equal(unk.status, 'insufficient');
assert.equal(unk.onset, null); assert.equal(unk.peak, null); assert.equal(unk.firstAffected, null);
assert.equal(unk.confidence, 'Insufficient data');
assert.equal(unk.band.uncertainOnly, true);

// --- nothing found / nothing observed ----------------------------------------------
assert.equal(detectEvent(mergeByDate([o('2025-08-05', 'clear'), o('2025-08-09', 'clear'), o('2025-08-20', 'clear')]), opts).status, 'none');
assert.equal(detectEvent([], opts).status, 'no-data');

// --- conflicting sources on one date: affected wins, conflict is flagged and lowers confidence
const conf = mergeByDate([o('2025-08-10', 'clear'), o('2025-08-14', 'affected', 5, 'A'), o('2025-08-14', 'clear', 0, 'B'), o('2025-08-20', 'clear')]);
assert.equal(conf[1].state, 'affected'); assert.equal(conf[1].conflict, true);
const evc = detectEvent(conf, opts);
assert.ok(evc.confidenceReasons.some(r => /disagree/.test(r)));

// --- wildfire: detections, gaps, and the note that detection ≠ containment ----------
const fire = detectEvent(mergeByDate([
  o('2025-01-03', 'clear'), o('2025-01-08', 'affected', 4), o('2025-01-12', 'clear'),
  o('2025-01-15', 'affected', 9), o('2025-01-22', 'clear')
]), { kind: 'fire', periodStart: '2025-01-01', periodEnd: '2025-02-28' });
assert.equal(fire.firstAffected, '2025-01-08'); assert.equal(fire.lastAffected, '2025-01-15');
assert.equal(fire.intermittent, true);
assert.deepEqual([fire.end.earliest, fire.end.latest], ['2025-01-15', '2025-01-22']);
assert.match(fire.method, /not containment/);

// --- phases & navigation targets use only real observation dates --------------------
const dates = flood.map(x => x.date);
assert.equal(phaseOf(ev, '2025-08-10'), 'before');
assert.equal(phaseOf(ev, '2025-08-20'), 'during');
assert.equal(phaseOf(ev, '2025-09-12'), 'after');
assert.deepEqual(phaseTargets(ev, dates), { before: '2025-08-10', during: '2025-08-20', after: '2025-09-03' });
assert.deepEqual(phaseTargets(open, ['2025-08-05', '2025-08-12']), { before: null, during: '2025-08-12', after: null });
assert.equal(phaseOf(unk, '2025-08-05'), null);
assert.equal(phaseOf(ev, '2025-08-12'), 'uncertain');    // inside the onset window
assert.equal(phaseOf(ev, '2025-08-30'), 'uncertain');    // inside the end window
assert.equal(phaseOf(open, '2025-08-20'), 'uncertain');  // event not observed to end
assert.equal(phaseOf(open, '2025-08-02'), 'uncertain');  // no clear observation before it

// --- documented records are filtered by the analysis period ---------------------------
const recs = [{ date: '2025-01-07' }, { date: '2025-01-31' }];
assert.deepEqual(recordsInPeriod(recs, '2025-01-01', '2025-01-20'), [{ date: '2025-01-07' }]);
assert.equal(daysBetween('2025-08-10', '2025-08-14'), 4);

console.log('event tests: all passed');

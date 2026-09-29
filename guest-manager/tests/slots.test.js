import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/slots.js';

describe('availability slots', () => {
  test('mergeRanges joins contiguous half-hours, ignores order and duplicates', () => {
    const r = S.mergeRanges(['2026-10-06T15:00', '2026-10-06T14:00', '2026-10-06T14:30', '2026-10-06T14:30', '2026-10-07T09:00', 'junk']);
    assert.deepEqual(r.map((x) => [x.start, x.end, x.slots.length]), [
      ['2026-10-06T14:00', '2026-10-06T15:30', 3],
      ['2026-10-07T09:00', '2026-10-07T09:30', 1]
    ]);
    assert.deepEqual(S.mergeRanges([]), []);
  });

  test('ranges can run past midnight', () => {
    const r = S.mergeRanges(['2026-10-06T23:30', '2026-10-07T00:00']);
    assert.equal(r.length, 1);
    assert.equal(r[0].end, '2026-10-07T00:30');
    assert.match(S.formatRange(r[0]), /Tue, Oct 6 · 11:30 PM – Wed, Oct 7 12:30 AM/);
  });

  test('formatRange', () => {
    assert.equal(S.formatRange({ start: '2026-10-06T14:00', end: '2026-10-06T16:00' }), 'Tue, Oct 6 · 2:00 PM – 4:00 PM');
  });

  test('time zone conversion round-trips and handles DST gaps', () => {
    const t = S.localToUtc('2026-10-06T14:00', 'Europe/Berlin');
    assert.equal(new Date(t).toISOString(), '2026-10-06T12:00:00.000Z');
    assert.equal(S.utcToLocal(t, 'America/New_York'), '2026-10-06T08:00');
    assert.equal(S.convertSlot('2026-10-06T14:00', 'Europe/Berlin', 'Asia/Tokyo'), '2026-10-06T21:00');
    // 02:30 on Mar 29 2026 does not exist in Berlin.
    assert.equal(S.localRoundTrips('2026-03-29T02:30', 'Europe/Berlin'), false);
    assert.equal(S.localRoundTrips('2026-03-29T03:30', 'Europe/Berlin'), true);
  });

  test('weekGrid: Monday first, 30-minute rows from 8:00 to 20:00, past cells flagged', () => {
    const nowMs = Date.parse('2026-10-06T10:00:00Z'); // Tue
    const start = S.weekStartFor(0, 'UTC', nowMs);
    assert.equal(start, '2026-10-05');
    const g = S.weekGrid({ weekStart: start, timeZone: 'UTC', nowMs });
    assert.equal(g.days.length, 7);
    assert.equal(g.times.length, 24);
    assert.equal(g.times[0], '08:00');
    assert.equal(g.times.at(-1), '19:30');
    assert.equal(g.days[0].cells[0].local, '2026-10-05T08:00');
    assert.equal(g.days[0].cells[0].past, true);
    assert.equal(g.days[1].cells[4].past, false); // Tue 10:00
    assert.ok(g.days.every((d) => d.cells.every((c) => c.valid)));
    assert.equal(S.weekStartFor(4, 'UTC', nowMs), '2026-11-02');
  });

  test('the same instants line up across zones', () => {
    const nowMs = Date.parse('2026-10-01T00:00:00Z');
    const host = S.weekGrid({ weekStart: '2026-10-05', timeZone: 'Europe/Berlin', nowMs });
    const guest = S.weekGrid({ weekStart: '2026-10-05', timeZone: 'America/New_York', nowMs });
    const hostUtc = new Set(host.days.flatMap((d) => d.cells.map((c) => c.utc)));
    const overlap = guest.days.flatMap((d) => d.cells).filter((c) => hostUtc.has(c.utc));
    assert.ok(overlap.length > 0);
    // 8:00 in New York is 14:00 in Berlin.
    const c = guest.days[1].cells[0];
    assert.equal(S.utcToLocal(c.utc, 'Europe/Berlin'), '2026-10-06T14:00');
  });

  test('upcomingRanges drops past slots and trims a partly past range', () => {
    const r = S.upcomingRanges(['2026-10-06T09:00', '2026-10-06T09:30', '2026-10-06T10:00', '2026-10-05T10:00'], '2026-10-06T09:15');
    assert.deepEqual(r.map((x) => [x.start, x.end]), [['2026-10-06T09:30', '2026-10-06T10:30']]);
  });

  test('rangesByDay groups ranges by start day', () => {
    const d = S.rangesByDay(['2026-10-06T09:00', '2026-10-07T09:00', '2026-10-07T12:00']);
    assert.deepEqual(Object.keys(d), ['2026-10-06', '2026-10-07']);
    assert.equal(d['2026-10-07'].length, 2);
  });

  test('availabilityToText lists ranges in both zones', () => {
    const t = S.availabilityToText({ showName: 'Deep Air', name: 'Sam', email: 's@x.test', timeZone: 'Europe/Berlin', guestTimeZone: 'America/New_York', slots: ['2026-10-06T14:00', '2026-10-06T14:30'] });
    assert.match(t, /Free times \(Europe\/Berlin\):\n- Tue, Oct 6 · 2:00 PM – 3:00 PM/);
    assert.match(t, /my time zone \(America\/New_York\):\n- Tue, Oct 6 · 8:00 AM – 9:00 AM/);
  });
});

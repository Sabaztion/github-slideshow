// Regression tests for the code review findings on the first version.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

let counter = 0;
const idFn = () => `r${++counter}`;

describe('review fixes: logic', () => {
  test('headshot check is ticked only when a photo actually arrived (a URL)', () => {
    const base = { name: 'Sam', email: 'sam@example.com', bio: 'Bio.', consent: true };
    assert.equal(L.intakeToGuest({ ...base, headshot: 'sam.jpg' }, { idFn }).checks.bio, false);
    const withUrl = L.intakeToGuest({ ...base, headshot: 'sam.jpg', headshotUrl: 'https://drive.google.com/file/d/abc/view' }, { idFn });
    assert.equal(withUrl.checks.bio, true);
    assert.equal(withUrl.headshot, 'https://drive.google.com/file/d/abc/view');
    assert.equal(L.intakeToGuest({ ...base, headshotUrl: 'javascript:alert(1)' }, { idFn }).checks.bio, false);
  });

  test('parseState rejects string and non-numeric versions that are too new or unreadable', () => {
    assert.throws(() => L.parseState('{"version":"9","guests":[]}'), /newer version/);
    assert.throws(() => L.parseState('{"version":"abc","guests":[]}'), /unreadable version/);
    assert.throws(() => L.parseState('{"version":{},"guests":[]}'), /unreadable version/);
    assert.equal(L.parseState('{"version":"1","guests":[]}').guests.length, 0);
    assert.equal(L.parseState('{"guests":[]}').guests.length, 0);
  });

  test('date-only recording values count as unscheduled', () => {
    assert.equal(L.normalizeGuest({ recordingAt: '2026-10-06' }, { idFn }).recordingAt, '');
    assert.equal(L.normalizeGuest({ recordingAt: '2026-10-06T09:30' }, { idFn }).recordingAt, '2026-10-06T09:30');
  });

  test('past intake slots are dropped from links and the form falls back to suggestions', () => {
    const settings = { showName: 'S', timeZone: 'UTC', intakeSlots: ['2026-09-01T10:00', '2026-10-05T10:00'] };
    const url = L.buildIntakeUrl('https://x.test/i.html', settings, { nowLocal: '2026-09-29T12:00' });
    assert.deepEqual(L.readIntakeParams(new URL(url).search).intakeSlots, ['2026-10-05T10:00']);
    assert.deepEqual(L.upcomingSlots(settings.intakeSlots, '2026-10-05T10:00'), []);
    const offered = L.slotsToOffer(['2026-09-01T10:00'], '2026-09-29T12:00');
    assert.ok(offered.length > 0);
    assert.ok(offered.every((s) => s > '2026-09-29T12:00'));
  });

  test('mailto bodies are capped and flagged when shortened', () => {
    const short = L.mailtoForText('h@x.test', 'S', 'hello');
    assert.equal(short.truncated, false);
    const long = L.mailtoForText('h@x.test', 'S', 'x'.repeat(5000));
    assert.equal(long.truncated, true);
    const body = decodeURIComponent(long.href.split('body=')[1]);
    assert.ok(body.length <= L.MAILTO_BODY_MAX + 10);
    assert.match(body, /Copy as text/);
  });

  test('safeHttpUrl only allows http and https', () => {
    assert.equal(L.safeHttpUrl('https://a.test/x'), 'https://a.test/x');
    assert.equal(L.safeHttpUrl('javascript:alert(1)'), '');
    assert.equal(L.safeHttpUrl('data:text/html,hi'), '');
    assert.equal(L.safeHttpUrl('@handle'), '');
  });
});

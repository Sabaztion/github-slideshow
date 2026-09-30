// Logic behind the accessibility and UX fixes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

describe('a11y/ux helpers', () => {
  test('isValidEmail matches the intake rule', () => {
    assert.equal(L.isValidEmail('a@b.co'), true);
    assert.equal(L.isValidEmail(' a@b.co '), true);
    assert.equal(L.isValidEmail('nope'), false);
    assert.equal(L.isValidEmail('a@b'), false);
    assert.equal(L.isValidEmail(''), false);
  });

  test('softUrlWarning allows http(s) and, optionally, handles', () => {
    assert.equal(L.softUrlWarning(''), '');
    assert.equal(L.softUrlWarning('https://x.test'), '');
    assert.match(L.softUrlWarning('x.test/ep1'), /https:\/\//);
    assert.equal(L.softUrlWarning('@maya', { allowHandle: true }), '');
    assert.match(L.softUrlWarning('javascript:alert(1)', { allowHandle: true }), /web address/);
  });

  test('hasNoRelease flags only intake guests without consent', () => {
    assert.equal(L.hasNoRelease({ source: 'intake', checks: { release: false } }), true);
    assert.equal(L.hasNoRelease({ source: 'intake', checks: { release: true } }), false);
    assert.equal(L.hasNoRelease({ source: '', checks: { release: false } }), false);
  });

  test('convertZone shows a host slot in the guest’s zone, across DST and dates', () => {
    assert.equal(L.convertZone('2026-10-06T14:00', 'Europe/Berlin', 'America/New_York'), '2026-10-06T08:00');
    assert.equal(L.convertZone('2026-10-06T01:00', 'Europe/Berlin', 'America/Los_Angeles'), '2026-10-05T16:00');
    // Berlin leaves DST on Oct 25 2026, New York on Nov 1: the gap is 5 h for that week.
    assert.equal(L.convertZone('2026-10-27T14:00', 'Europe/Berlin', 'America/New_York'), '2026-10-27T09:00');
    assert.equal(L.convertZone('2026-10-06T14:00', 'UTC', 'UTC'), '2026-10-06T14:00');
    assert.equal(L.convertZone('2026-10-06T14:00', 'Asia/Kathmandu', 'UTC'), '2026-10-06T08:15');
  });
});

describe('guest-facing error wording', async () => {
  const { guestErrorMessage } = await import('../js/guest-page.js');
  test('setup problems are not explained to guests; server reasons and network hints are', () => {
    const err = (kind, message) => Object.assign(new Error(message), { kind });
    assert.doesNotMatch(guestErrorMessage(err('setup', 'Is the web app deployed with access set to “Anyone”?')), /deployed|Anyone/);
    assert.doesNotMatch(guestErrorMessage(err('http', 'HTTP 500')), /HTTP/);
    assert.match(guestErrorMessage(err('network', 'x')), /connection/);
    assert.equal(guestErrorMessage(err('rejected', 'Email is not valid.')), 'Email is not valid.');
  });
});

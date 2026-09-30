import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/remote.js';
import * as L from '../js/logic.js';

let n = 0;
const idFn = () => `n${++n}`;
const NOW = '2026-10-01T12:00:00.000Z';
const TOKEN = 'tabcdef0123456789abcdef';
const tokenFn = () => `t${String(++n).padStart(20, '0')}`;
const state = (guests = [], tz = 'Europe/Berlin') => ({ ...L.createInitialState({ timeZone: tz, withSamples: false }), guests });

const intakeSub = (over = {}) => R.normalizeSubmission({
  id: 's_1', type: 'intake', submittedAt: '2026-10-01T10:00:00.000Z', name: 'Sam Rivera', email: 'sam@example.com',
  pronouns: 'they/them', role: 'Birder', topic: 'City owls', bio: 'Sam watches owls.', social: 'https://sam.example',
  availability: '2026-10-05T10:00, 2026-10-07T16:00', timeZone: 'Europe/Berlin', setup: 'remote-own', notes: 'Promoting a zine.',
  consent: 'TRUE', headshotName: 'sam.jpg', headshotUrl: 'https://drive.google.com/file/d/1/view', ...over
});

describe('payloads', () => {
  test('buildIntakePayload trims, caps and includes the honeypot and headshot', () => {
    const p = R.buildIntakePayload({ name: '  Sam ', email: 'sam@example.com', bio: 'x'.repeat(5000), availability: ['2026-10-05T10:00', 'bad'], consent: true },
      { showName: 'Deep Air', timeZone: 'Europe/Berlin', headshot: { name: 'me.jpg', type: 'image/jpeg', data: 'AAAA' } });
    assert.equal(p.type, 'intake');
    assert.equal(p.name, 'Sam');
    assert.equal(p.bio.length, R.LIMITS.bio);
    assert.deepEqual(p.availability, ['2026-10-05T10:00']);
    assert.equal(p[R.HONEYPOT_FIELD], '');
    assert.deepEqual(p.headshot, { name: 'me.jpg', type: 'image/jpeg', data: 'AAAA' });
    assert.equal(R.validatePayload(p), '');
    assert.ok(!('readKey' in p) && !('key' in p));
  });

  test('validatePayload mirrors the server rules', () => {
    const base = R.buildIntakePayload({ name: 'Sam', email: 'sam@example.com' }, { timeZone: 'UTC' });
    assert.match(R.validatePayload({ ...base, name: '' }), /name/);
    assert.match(R.validatePayload({ ...base, email: 'x' }), /email/);
    assert.match(R.validatePayload({ ...base, headshot: { type: 'image/gif', data: 'AAAA' } }), /JPEG/);
    const big = 'A'.repeat(Math.ceil((R.LIMITS.headshotBytes + 10) * 4 / 3));
    assert.match(R.validatePayload({ ...base, headshot: { type: 'image/jpeg', data: big } }), /too large/);
    assert.match(R.validatePayload(R.buildAvailabilityPayload({ name: 'A', email: 'a@b.co', slots: [] }, {})), /at least one/);
    assert.match(R.validatePayload(R.buildQaPayload({ name: 'A', email: 'a@b.co', answers: [{ id: 'q1', answer: '' }] }, {})), /at least one/);
    assert.match(R.validatePayload({ type: 'nope' }), /Unknown/);
  });

  test('availability and qa payloads', () => {
    const a = R.buildAvailabilityPayload({ name: 'Sam', email: 'sam@example.com', token: TOKEN, slots: ['2026-10-06T14:30', '2026-10-06T14:00', 'x'], slotsUtc: ['2026-10-06T12:30Z', '2026-10-06T12:00:00.000Z', 'nope'], guestTimeZone: 'America/New_York' }, { showName: 'S', timeZone: 'Europe/Berlin' });
    assert.deepEqual(a.slots, ['2026-10-06T14:00', '2026-10-06T14:30']);
    assert.deepEqual(a.slotsUtc, ['2026-10-06T12:00Z', '2026-10-06T12:30Z']);
    assert.equal(a.token, TOKEN);
    assert.equal(R.buildAvailabilityPayload({ token: 'short' }, {}).token, '');
    const q = R.buildQaPayload({ name: 'Sam', email: 'sam@example.com', answers: [{ id: 'q1', question: 'Q?', answer: ' A ' }, { id: 'bad id', answer: 'x' }], topics: 'Owls' }, {});
    assert.deepEqual(q.answers, [{ id: 'q1', question: 'Q?', answer: 'A' }]);
    assert.equal(R.validatePayload(q), '');
  });

  test('fitWithin, base64Bytes, parseDataUrl', () => {
    assert.deepEqual(R.fitWithin(4000, 3000, 1000), { width: 1000, height: 750 });
    assert.deepEqual(R.fitWithin(800, 600, 1000), { width: 800, height: 600 });
    assert.equal(R.base64Bytes('AAAA'), 3);
    assert.equal(R.base64Bytes('AAA='), 2);
    assert.deepEqual(R.parseDataUrl('data:image/jpeg;base64,AAAA'), { type: 'image/jpeg', data: 'AAAA' });
    assert.equal(R.parseDataUrl('javascript:x'), null);
  });
});

describe('list responses', () => {
  test('health-check reply to a list call means the key was rejected', () => {
    const r = R.parseListResponse({ ok: true, service: 'guest-intake' });
    assert.equal(r.ok, false);
    assert.equal(r.keyRejected, true);
    assert.equal(R.parseListResponse({ ok: false, error: 'Boom' }).error, 'Boom');
    assert.equal(R.parseListResponse(null).ok, false);
    const ok = R.parseListResponse({ ok: true, now: NOW, submissions: [{ id: 's_1', email: 'a@b.co', name: 'A' }, { id: '', email: 'x' }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.submissions.length, 1);
    assert.equal(ok.now, NOW);
  });

  test('normalizeSubmission drops unsafe headshot URLs and parses qa answers', () => {
    assert.equal(intakeSub({ headshotUrl: 'javascript:alert(1)' }).headshotUrl, '');
    assert.equal(intakeSub().consent, true);
    const q = R.normalizeSubmission({ id: 's_2', type: 'qa', email: 'a@b.co', answers: '[{"id":"q1","question":"Q","answer":"A"}]' });
    assert.deepEqual(q.answers, [{ id: 'q1', question: 'Q', answer: 'A' }]);
  });

  test('listUrl carries the key only in the list call', () => {
    const u = new URL(R.listUrl('https://script.google.com/macros/s/X/exec', 'secret-key-123456', '2026-10-01T00:00:00.000Z'));
    assert.equal(u.searchParams.get('action'), 'list');
    assert.equal(u.searchParams.get('key'), 'secret-key-123456');
    assert.equal(R.listUrl('ftp://x', 'k', ''), '');
  });

  test('share links never include the read key', () => {
    const settings = { ...L.defaultSettings('UTC'), intakeEndpoint: 'https://script.google.com/macros/s/X/exec', readKey: 'secret-key-123456' };
    const url = L.buildIntakeUrl('https://x.test/intake.html', settings, { guest: { id: 'g_1', token: TOKEN, name: 'Sam', email: 's@x.test' } });
    assert.ok(!url.includes('secret-key'));
    assert.ok(!url.includes('g_1'), 'the guest id is not in links; the token is');
    const p = L.readIntakeParams(new URL(url).search);
    assert.equal(p.endpoint, 'https://script.google.com/macros/s/X/exec');
    assert.equal(p.guestToken, TOKEN);
    assert.equal(p.guestEmail, 's@x.test');
    assert.equal(L.readIntakeParams('?api=javascript:alert(1)').endpoint, undefined);
    assert.equal(L.readIntakeParams('?api=http://evil.test/x').endpoint, undefined);
    assert.equal(L.readIntakeParams('?api=https://evil.test/macros/s/X/exec').endpoint, undefined, 'only script.google.com');
    assert.equal(L.readIntakeParams('?api=' + encodeURIComponent('https://script.google.com/macros/s/X/exec?x=1')).endpoint, undefined);
    assert.equal(L.readIntakeParams('?api=' + encodeURIComponent('https://script.google.com.evil.test/macros/s/X/exec')).endpoint, undefined);
    assert.equal(L.readIntakeParams('?api=http://localhost:9/x').endpoint, 'http://localhost:9/x');
  });

  test('the read key is only usable for the endpoint it was entered for', () => {
    const E = 'https://script.google.com/macros/s/AAA/exec';
    const sync = R.normalizeSync({ readKey: 'k'.repeat(40), keyEndpoint: E });
    assert.equal(R.keyUsable(sync, E), true);
    assert.equal(R.keyUsable(sync, 'https://script.google.com/macros/s/BBB/exec'), false, 'imported backup with another endpoint');
    assert.equal(R.keyUsable({ ...sync, keyEndpoint: '' }, E), false);
    assert.equal(R.keyUsable({ ...sync, readKey: '' }, E), false);
  });

  test('sync helpers', () => {
    const s = R.normalizeSync({ readKey: ' k ', lastSync: NOW, seenIds: ['a', 3, ''], autoCheck: false, keyEndpoint: 'https://evil.test/x' });
    assert.deepEqual(s, { readKey: 'k', lastSync: NOW, seenIds: ['a'], autoCheck: false, keyEndpoint: '' });
    assert.equal(R.normalizeSync(null).autoCheck, true);
    assert.equal(R.sinceFor(NOW), '2026-10-01T11:55:00.000Z');
    assert.equal(R.sinceFor(''), '');
  });
});

describe('importing submissions', () => {
  test('a new intake submission becomes an Outreach guest with everything carried over', () => {
    const r = R.applySubmissions(state(), [intakeSub()], { idFn, nowIso: NOW });
    assert.deepEqual(r.counts.created, 1);
    const g = r.state.guests[0];
    assert.equal(g.stage, 'outreach');
    assert.equal(g.name, 'Sam Rivera');
    assert.equal(g.bio, 'Sam watches owls.');
    assert.equal(g.social, 'https://sam.example');
    assert.deepEqual(g.availability, ['2026-10-05T10:00', '2026-10-07T16:00']);
    assert.equal(g.headshot, 'https://drive.google.com/file/d/1/view');
    assert.equal(g.checks.bio, true);
    assert.equal(g.checks.release, true);
    assert.match(g.notes, /Promoting a zine/);
    assert.match(g.notes, /Remote, own mic/);
    assert.deepEqual(r.seenIds, ['s_1']);
    assert.equal(R.importSummary(r.counts), 'Added 1 new guest.');
  });

  test('checking twice never duplicates', () => {
    const first = R.applySubmissions(state(), [intakeSub()], { idFn, nowIso: NOW });
    const second = R.applySubmissions(first.state, [intakeSub()], { seenIds: first.seenIds, idFn, nowIso: NOW });
    assert.equal(second.state.guests.length, 1);
    assert.equal(second.counts.skipped, 1);
    assert.equal(R.importSummary(second.counts), 'No new submissions.');
  });

  test('a submission that matches only by email waits for review instead of changing the guest', () => {
    const existing = L.createGuest({ name: 'Sam R.', email: 'SAM@example.com', stage: 'booked', recordingAt: '2026-10-06T14:00', bio: 'Host-written bio', checks: { call: true, release: true } }, { idFn, nowIso: NOW });
    const r = R.applySubmissions(state([existing]), [intakeSub({ id: 's_2', consent: false, headshotUrl: 'https://evil.test/x.jpg' })], { idFn, nowIso: NOW });
    assert.equal(r.state.guests.length, 1);
    assert.equal(r.counts.pending, 1);
    assert.equal(r.counts.updated, 0);
    const g = r.state.guests[0];
    assert.equal(g.checks.release, true, 'untouched');
    assert.equal(g.headshot, '', 'untouched');
    assert.equal(g.pending.length, 1);
    assert.match(R.importSummary(r.counts), /1 submission matched an existing guest only by email/);
    assert.match(R.describePending(g.pending[0]), /Sam Rivera <sam@example.com> sent an intake form/);
    // The host accepts it: fields merge, host progress stays, consent can't be cleared.
    const acc = R.acceptPending(g, 's_2', { nowIso: NOW, hostTimeZone: 'Europe/Berlin' });
    assert.equal(acc.pending.length, 0);
    assert.equal(acc.name, 'Sam R.', 'host edits kept');
    assert.equal(acc.bio, 'Host-written bio');
    assert.equal(acc.stage, 'booked');
    assert.equal(acc.recordingAt, '2026-10-06T14:00');
    assert.equal(acc.checks.call, true);
    assert.equal(acc.checks.release, true, 'a submission never clears consent');
    assert.equal(acc.role, 'Birder', 'empty fields filled');
    assert.equal(R.discardPending(g, 's_2').pending.length, 0);
    // Checking again doesn't queue it twice.
    const again = R.applySubmissions(r.state, [intakeSub({ id: 's_2' })], { seenIds: r.seenIds, idFn, nowIso: NOW });
    assert.equal(again.state.guests[0].pending.length, 1);
  });

  test('a submission with the guest’s link token merges straight in, and only ever sets consent', () => {
    const existing = L.createGuest({ name: 'Sam', email: 'other@example.com', token: TOKEN, checks: { release: true } }, { idFn, nowIso: NOW });
    const r = R.applySubmissions(state([existing]), [intakeSub({ id: 's_9', token: TOKEN, consent: false })], { idFn, nowIso: NOW });
    assert.equal(r.counts.updated, 1);
    assert.equal(r.counts.pending, 0);
    assert.equal(r.state.guests[0].checks.release, true);
    assert.equal(r.state.guests[0].role, 'Birder');
    const r2 = R.applySubmissions(state([{ ...existing, checks: { ...existing.checks, release: false } }]), [intakeSub({ id: 's_10', token: TOKEN, consent: true })], { idFn, nowIso: NOW });
    assert.equal(r2.state.guests[0].checks.release, true);
  });

  test('new guests from a submission get their own link token', () => {
    const r = R.applySubmissions(state(), [intakeSub({ id: 's_11' })], { idFn, nowIso: NOW, tokenFn });
    assert.match(r.state.guests[0].token, /^t0+\d+$/);
  });

  test('sample guests are never merged into', () => {
    const sample = { ...L.createGuest({ name: 'Maya', email: 'sam@example.com' }, { idFn }), sample: true };
    const r = R.applySubmissions(state([sample]), [intakeSub()], { idFn, nowIso: NOW });
    assert.equal(r.state.guests.length, 2);
  });

  test('availability with the token converts zones and replaces free slots', () => {
    const g0 = L.createGuest({ name: 'Sam', email: 'other@example.com', token: TOKEN, freeSlots: ['2026-10-01T09:00'] }, { idFn, nowIso: NOW });
    const sub = R.normalizeSubmission({ id: 's_3', type: 'availability', submittedAt: NOW, token: TOKEN, name: 'Sam', email: 'sam@example.com', timeZone: 'UTC', guestTimeZone: 'America/New_York', slots: '2026-10-06T12:00, 2026-10-06T12:30' });
    const r = R.applySubmissions(state([g0], 'Europe/Berlin'), [sub], { idFn, nowIso: NOW });
    assert.equal(r.state.guests.length, 1);
    assert.deepEqual(r.state.guests[0].freeSlots, ['2026-10-06T14:00', '2026-10-06T14:30']);
    assert.match(r.state.guests[0].notes, /America\/New_York/);
  });

  test('availability sent as UTC instants is converted on the host side', () => {
    const g0 = L.createGuest({ name: 'Sam', email: 'sam@example.com', token: TOKEN }, { idFn, nowIso: NOW });
    // 00:30 and 01:30 UTC on Oct 25 2026 are both 02:30 in Berlin (the fall-back hour); the host keeps one free slot.
    const sub = R.normalizeSubmission({ id: 's_utc', type: 'availability', submittedAt: NOW, token: TOKEN, email: 'sam@example.com', timeZone: 'Europe/Berlin', slots: '2026-10-25T02:30', slotsUtc: '2026-10-25T00:30Z, 2026-10-25T01:30Z, 2026-10-25T09:00Z' });
    const r = R.applySubmissions(state([g0], 'America/New_York'), [sub], { idFn, nowIso: NOW });
    assert.deepEqual(r.state.guests[0].freeSlots, ['2026-10-24T20:30', '2026-10-24T21:30', '2026-10-25T05:00']);
  });

  test('availability matching only the guest id waits for review', () => {
    const g0 = L.createGuest({ name: 'Sam', email: 'x@example.com' }, { idFn, nowIso: NOW });
    const sub = R.normalizeSubmission({ id: 's_gid', type: 'availability', submittedAt: NOW, guestId: g0.id, email: 'attacker@example.com', slots: '2026-10-06T12:00' });
    const r = R.applySubmissions(state([g0]), [sub], { idFn, nowIso: NOW });
    assert.deepEqual(r.state.guests[0].freeSlots, []);
    assert.equal(r.state.guests[0].pending.length, 1);
  });

  test('availability from an unknown guest creates an Outreach guest', () => {
    const sub = R.normalizeSubmission({ id: 's_4', type: 'availability', submittedAt: NOW, name: 'New Person', email: 'new@example.com', timeZone: 'Europe/Berlin', slots: ['2026-10-06T14:00'] });
    const r = R.applySubmissions(state(), [sub], { idFn, nowIso: NOW });
    assert.equal(r.state.guests[0].stage, 'outreach');
    assert.deepEqual(r.state.guests[0].freeSlots, ['2026-10-06T14:00']);
  });

  test('qa answers merge by id then email; re-import keeps the latest answers', () => {
    const g0 = L.createGuest({ name: 'Sam', email: 'sam@example.com', token: TOKEN, qa: { questions: [{ id: 'q1', text: 'Intro?' }], sentAt: NOW } }, { idFn, nowIso: NOW });
    const a1 = R.normalizeSubmission({ id: 's_5', type: 'qa', token: TOKEN, submittedAt: '2026-10-02T00:00:00.000Z', name: 'Sam', email: 'sam@example.com', answers: [{ id: 'q1', question: 'Intro?', answer: 'First' }] });
    const a2 = R.normalizeSubmission({ id: 's_6', type: 'qa', token: TOKEN, submittedAt: '2026-10-03T00:00:00.000Z', name: 'Sam', email: 'sam@example.com', answers: [{ id: 'q1', question: 'Intro?', answer: 'Second' }], topics: 'Owls' });
    // Delivered out of order: the newer one still wins.
    const r = R.applySubmissions(state([g0]), [a2, a1], { idFn, nowIso: NOW });
    const g = r.state.guests[0];
    assert.equal(g.qa.answers.q1.text, 'Second');
    assert.equal(g.qa.answers.q1.answeredAt, '2026-10-03T00:00:00.000Z');
    assert.equal(g.qa.topics, 'Owls');
    assert.equal(r.state.guests.length, 1);
    const again = R.applySubmissions(r.state, [a1, a2], { seenIds: r.seenIds, idFn, nowIso: NOW });
    assert.equal(again.state.guests[0].qa.answers.q1.text, 'Second');
    assert.equal(again.counts.skipped, 2);
  });
});

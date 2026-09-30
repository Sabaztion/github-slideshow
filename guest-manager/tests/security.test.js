// Regression tests for the security review of 50ea24d.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';
import * as P from '../js/plan.js';
import * as S from '../js/slots.js';

describe('security review fixes', () => {
  test('only Apps Script web app URLs (or localhost) are accepted as endpoints', () => {
    assert.equal(L.normalizeEndpoint('https://script.google.com/macros/s/AKfy_cb-12/exec'), 'https://script.google.com/macros/s/AKfy_cb-12/exec');
    for (const bad of ['https://evil.test/exec', 'https://script.google.com/macros/s/X/dev', 'https://script.google.com/macros/s/X/exec?key=1',
      'https://script.google.com.evil.test/macros/s/X/exec', 'http://script.google.com/macros/s/X/exec', 'https://u:p@script.google.com/macros/s/X/exec', 'javascript:alert(1)']) {
      assert.equal(L.normalizeEndpoint(bad), '', bad);
    }
    assert.equal(L.normalizeEndpoint('http://127.0.0.1:8080/mock'), 'http://127.0.0.1:8080/mock');
    assert.equal(L.endpointHost('https://script.google.com/macros/s/X/exec'), 'script.google.com');
  });

  test('a backup can’t smuggle in an endpoint that normalizeSettings accepts only if valid', () => {
    assert.equal(L.normalizeSettings({ intakeEndpoint: 'https://evil.test/collect' }).intakeEndpoint, '');
  });

  test('every guest gets a link token, kept across save/load', () => {
    let n = 0;
    const state = L.createInitialState({ timeZone: 'UTC', today: '2026-09-28' });
    const withTokens = L.ensureGuestTokens(state, () => `tok${String(++n).padStart(16, '0')}`);
    assert.ok(withTokens.guests.every((g) => L.TOKEN_RE.test(g.token)));
    assert.equal(L.ensureGuestTokens(withTokens), withTokens, 'no change when all have one');
    const back = L.parseState(L.serializeState(withTokens));
    assert.deepEqual(back.guests.map((g) => g.token), withTokens.guests.map((g) => g.token));
    assert.equal(L.normalizeGuest({ token: 'bad token' }).token, '');
    assert.match(L.newGuestToken(), L.TOKEN_RE);
  });

  test('pending submissions survive a save/load round trip as plain data', () => {
    const g = L.normalizeGuest({ name: 'A', pending: [{ id: 's_1', type: 'intake', email: 'a@b.co' }, 'junk', { noId: true }] });
    assert.equal(g.pending.length, 1);
  });

  test('answers to removed questions are kept and shown, with their question text', () => {
    let qa = P.normalizeQa({ questions: [{ id: 'q1', text: 'Intro?' }] });
    qa = P.mergeQaAnswers(qa, { answers: [{ id: 'q1', question: 'Intro?', answer: 'Hi' }, { id: 'q2', question: 'Pronunciation?', answer: 'SAM' }], submittedAt: '2026-10-02T00:00:00.000Z' });
    qa = { ...qa, questions: qa.questions.filter((q) => q.id !== 'q2') }; // host deletes q2
    const orphans = P.orphanAnswers(qa);
    assert.deepEqual(orphans.map((o) => [o.id, o.question, o.text]), [['q2', 'Pronunciation?', 'SAM']]);
    const sheet = P.runSheet({ name: 'Sam', plan: {}, qa });
    assert.deepEqual(sheet.answers.map((a) => a.question), ['Intro?', 'Pronunciation?']);
  });

  test('a range ending at midnight on a later day shows both dates', () => {
    assert.equal(S.formatRange({ start: '2026-10-06T23:00', end: '2026-10-07T00:00' }), 'Tue, Oct 6 · 11:00 PM – 12:00 AM');
    assert.equal(S.formatRange({ start: '2026-10-06T23:00', end: '2026-10-08T00:00' }), 'Tue, Oct 6 · 11:00 PM – Thu, Oct 8 12:00 AM');
  });

  test('the plan total and the run sheet agree when a talking point is blank', () => {
    const segments = [{ id: 's1', text: 'Intro', minutes: 5 }, { id: 's2', text: '  ', minutes: 30 }];
    const sheet = P.runSheet({ name: 'Sam', plan: { segments }, qa: {} });
    assert.equal(sheet.totalMinutes, P.segmentTimings(segments.filter((x) => x.text.trim())).total);
    assert.equal(sheet.totalMinutes, 5);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/plan.js';
import * as L from '../js/logic.js';

let n = 0;
const idFn = () => `t${++n}`;

describe('episode plan', () => {
  test('normalizePlan cleans items, minutes and duplicate ids', () => {
    const p = P.normalizePlan({ title: 'T', segments: [{ id: 's1', text: 'Intro', minutes: '5' }, { id: 's1', text: 'Dup', minutes: -3 }, null, { text: 'No id', minutes: 9999 }], airQuestions: 'nope' });
    assert.equal(p.title, 'T');
    assert.equal(p.segments.length, 3);
    assert.equal(p.segments[0].minutes, 5);
    assert.notEqual(p.segments[1].id, 's1');
    assert.equal(p.segments[1].minutes, 0);
    assert.equal(p.segments[2].minutes, P.PLAN_LIMITS.minutes);
    assert.deepEqual(p.airQuestions, []);
    assert.deepEqual(P.normalizePlan(p), p, 'idempotent');
  });

  test('add, update, move and remove items', () => {
    let list = [];
    list = P.addItem(list, 'A', { idFn, minutes: 5 });
    list = P.addItem(list, 'B', { idFn, minutes: 10 });
    list = P.addItem(list, 'C', { idFn });
    assert.deepEqual(list.map((x) => x.text), ['A', 'B', 'C']);
    list = P.moveItem(list, list[2].id, -1);
    assert.deepEqual(list.map((x) => x.text), ['A', 'C', 'B']);
    assert.equal(P.moveItem(list, list[0].id, -1), list, 'no-op at the top');
    list = P.updateItem(list, list[0].id, { text: 'A2', minutes: '7' });
    assert.equal(list[0].text, 'A2');
    assert.equal(list[0].minutes, 7);
    list = P.removeItem(list, list[1].id);
    assert.deepEqual(list.map((x) => x.text), ['A2', 'B']);
  });

  test('segmentTimings gives running totals', () => {
    const t = P.segmentTimings([{ id: 'a', text: 'x', minutes: 5 }, { id: 'b', text: 'y', minutes: 0 }, { id: 'c', text: 'z', minutes: 20 }]);
    assert.deepEqual(t.rows.map((r) => [r.start, r.end]), [[0, 5], [5, 5], [5, 25]]);
    assert.equal(t.total, 25);
    assert.equal(P.formatMinutes(25), '25 min');
    assert.equal(P.formatMinutes(75), '1 h 15 min');
  });
});

describe('guest Q&A', () => {
  test('question bank defaults and seeding', () => {
    assert.ok(P.DEFAULT_QUESTION_BANK.length >= 7);
    const qs = P.seedQuestions(['One?', '  ', 'Two?'], { idFn });
    assert.deepEqual(qs.map((q) => q.text), ['One?', 'Two?']);
    assert.ok(qs.every((q) => q.id));
    const s = L.defaultSettings('UTC');
    assert.deepEqual(s.questionBank, [...P.DEFAULT_QUESTION_BANK]);
    assert.deepEqual(L.normalizeSettings({ questionBank: ['Only this?'] }).questionBank, ['Only this?']);
  });

  test('status goes not-sent -> sent -> answered', () => {
    let g = L.createGuest({ name: 'Sam' }, { idFn });
    assert.equal(P.qaStatus(g), 'not-sent');
    g = P.markQaSent(g, ['Q1?', 'Q2?'], '2026-10-01T00:00:00.000Z', { idFn });
    assert.equal(P.qaStatus(g), 'sent');
    assert.equal(g.qa.questions.length, 2);
    const again = P.markQaSent(g, ['Other?'], '2026-10-02T00:00:00.000Z');
    assert.equal(again.qa.sentAt, '2026-10-01T00:00:00.000Z', 'first send time is kept');
    assert.equal(again.qa.questions.length, 2, 'existing questions are kept');
    g = { ...g, qa: P.mergeQaAnswers(g.qa, { answers: [{ id: g.qa.questions[0].id, answer: 'Hi' }], submittedAt: '2026-10-03T00:00:00.000Z' }) };
    assert.equal(P.qaStatus(g), 'answered');
  });

  test('questions encode into a compact URL-safe param and decode back', () => {
    const qs = [{ id: 'q1', text: 'How would you like to be introduced?' }, { id: 'q2', text: 'Ünïcödé & emoji 🎙️ / + = ?' }];
    const enc = P.encodeQuestions(qs);
    assert.match(enc.param, /^[A-Za-z0-9_-]+$/);
    assert.equal(enc.included, 2);
    assert.equal(enc.dropped, 0);
    assert.deepEqual(P.decodeQuestions(enc.param), qs);
    assert.deepEqual(P.decodeQuestions('!!!'), []);
    assert.deepEqual(P.decodeQuestions(''), []);
  });

  test('too many or too long questions are capped and reported', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, text: `${'Long question text '.repeat(15)}${i}?` }));
    const enc = P.encodeQuestions(many);
    assert.ok(enc.param.length <= P.QA_LIMITS.linkParam);
    assert.ok(enc.included < 20);
    assert.equal(enc.included + enc.dropped, 30);
    assert.equal(P.decodeQuestions(enc.param).length, enc.included);
  });

  test('mergeQaAnswers: latest wins, older answers never overwrite, unknown ids are added', () => {
    let qa = P.normalizeQa({ questions: [{ id: 'q1', text: 'Intro?' }] });
    qa = P.mergeQaAnswers(qa, { answers: [{ id: 'q1', question: 'Intro?', answer: 'v2' }, { id: 'q9', question: 'Extra?', answer: 'x' }], topics: 'Owls', submittedAt: '2026-10-02T00:00:00.000Z' });
    assert.equal(qa.answers.q1.text, 'v2');
    assert.equal(qa.answers.q1.answeredAt, '2026-10-02T00:00:00.000Z');
    assert.deepEqual(qa.questions.map((q) => q.id), ['q1', 'q9']);
    assert.equal(qa.topics, 'Owls');
    const older = P.mergeQaAnswers(qa, { answers: [{ id: 'q1', answer: 'v1' }], topics: 'Old', submittedAt: '2026-10-01T00:00:00.000Z' });
    assert.equal(older.answers.q1.text, 'v2');
    assert.equal(older.topics, 'Owls');
    const newer = P.mergeQaAnswers(qa, { answers: [{ id: 'q1', answer: 'v3' }], submittedAt: '2026-10-05T00:00:00.000Z' });
    assert.equal(newer.answers.q1.text, 'v3');
    assert.equal(newer.answeredAt, '2026-10-05T00:00:00.000Z');
  });

  test('promoteAnswer copies an answer into the plan', () => {
    let g = L.createGuest({ name: 'Sam', qa: { questions: [{ id: 'q1', text: 'Favourite story?' }], answers: { q1: { text: 'The owl in the library', answeredAt: '2026-10-02T00:00:00.000Z' } } } }, { idFn });
    g = P.promoteAnswer(g, 'q1', 'segment', { idFn });
    g = P.promoteAnswer(g, 'q1', 'air', { idFn });
    assert.equal(g.plan.segments[0].text, 'The owl in the library');
    assert.match(g.plan.airQuestions[0].text, /Favourite story\?.*owl/);
    assert.equal(P.promoteAnswer(g, 'nope', 'air'), g);
  });

  test('run sheet combines plan, bio and answers', () => {
    const g = L.createGuest({
      name: 'Sam Rivera', role: 'Birder', bio: 'Sam watches owls.',
      plan: { title: 'Night owls', angle: 'Cities at night', segments: [{ id: 's1', text: 'Intro', minutes: 5 }, { id: 's2', text: 'Owl stories', minutes: 20 }], airQuestions: [{ id: 'a1', text: 'Why owls?' }] },
      qa: { questions: [{ id: 'q1', text: 'Intro?' }, { id: 'q2', text: 'Unanswered?' }], answers: { q1: { text: 'Call me Sam', answeredAt: '2026-10-02T00:00:00.000Z' } }, topics: 'Urban wildlife' }
    }, { idFn });
    const sheet = P.runSheet(g, { showName: 'Deep Air', recordingLabel: 'Tue Oct 6 · 2:00 PM (UTC)' });
    assert.equal(sheet.title, 'Night owls');
    assert.equal(sheet.totalMinutes, 25);
    assert.equal(sheet.answers.length, 1);
    const text = P.runSheetToText(sheet);
    assert.match(text, /^Night owls\nDeep Air/);
    assert.match(text, /Talking points \(25 min\)\n1\. Intro \[5 min, 0–5\]\n2\. Owl stories \[20 min, 5–25\]/);
    assert.match(text, /On-air questions\n1\. Why owls\?/);
    assert.match(text, /Q: Intro\?\nA: Call me Sam/);
    assert.match(text, /Urban wildlife/);
    assert.equal(P.runSheet(L.createGuest({ name: 'X' }, { idFn })).title, 'Episode with X');
  });

  test('qaToText for the fallback', () => {
    const t = P.qaToText({ showName: 'Deep Air', name: 'Sam', email: 's@x.test', questions: [{ id: 'q1', text: 'Intro?' }], answers: { q1: 'Hi' }, topics: '' });
    assert.match(t, /Intro\?\nHi/);
  });

  test('normalizeGuest keeps plan and qa through a save/load round trip', () => {
    const g = L.createGuest({ name: 'Sam', freeSlots: ['2026-10-06T14:00', 'bad'], plan: { title: 'T', segments: [{ id: 's1', text: 'x', minutes: 3 }] }, qa: { questions: [{ id: 'q1', text: 'Q?' }], answers: { q1: { text: 'A', answeredAt: '2026-10-02T00:00:00.000Z' }, 'bad id!': { text: 'x' } }, sentAt: 'not a date' } }, { idFn });
    assert.deepEqual(g.freeSlots, ['2026-10-06T14:00']);
    assert.equal(g.qa.sentAt, '');
    assert.deepEqual(Object.keys(g.qa.answers), ['q1']);
    assert.deepEqual(L.normalizeGuest(JSON.parse(JSON.stringify(g))), g);
  });
});

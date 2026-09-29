// Run with: node --test guest-manager/tests/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

let counter = 0;
const idFn = () => `id${++counter}`;
const NOW = '2026-09-28T12:00:00.000Z';

const guest = (over = {}) => L.createGuest({ name: 'Test Guest', ...over }, { idFn, nowIso: NOW });

describe('stages', () => {
  test('pipeline order includes Editing between Recorded and Published', () => {
    assert.deepEqual(L.STAGE_IDS, ['outreach', 'booked', 'recorded', 'editing', 'published']);
  });

  test('nextStage / prevStage walk the pipeline and stop at the ends', () => {
    assert.equal(L.nextStage('outreach').id, 'booked');
    assert.equal(L.nextStage('recorded').id, 'editing');
    assert.equal(L.nextStage('editing').id, 'published');
    assert.equal(L.nextStage('published'), null);
    assert.equal(L.nextStage('nope'), null);
    assert.equal(L.prevStage('outreach'), null);
    assert.equal(L.prevStage('published').id, 'editing');
  });

  test('moveGuest changes stage immutably and stamps the time', () => {
    const g = guest();
    const moved = L.moveGuest(g, 'recorded', '2026-10-01T00:00:00.000Z');
    assert.equal(g.stage, 'outreach');
    assert.equal(moved.stage, 'recorded');
    assert.equal(moved.stageChangedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(moved.updatedAt, '2026-10-01T00:00:00.000Z');
  });

  test('moveGuest to the same stage returns the same object', () => {
    const g = guest({ stage: 'booked' });
    assert.equal(L.moveGuest(g, 'booked'), g);
  });

  test('moveGuest rejects unknown stages', () => {
    assert.throws(() => L.moveGuest(guest(), 'archived'), /Unknown stage/);
  });

  test('advanceGuest moves one step and is a no-op at the end', () => {
    let g = guest();
    const seen = [g.stage];
    for (let i = 0; i < 6; i++) {
      g = L.advanceGuest(g, NOW);
      seen.push(g.stage);
    }
    assert.deepEqual(seen, ['outreach', 'booked', 'recorded', 'editing', 'published', 'published', 'published']);
  });

  test('countByStage counts every stage, including empty ones', () => {
    const counts = L.countByStage([guest(), guest({ stage: 'editing' }), guest({ stage: 'editing' })]);
    assert.deepEqual(counts, { outreach: 1, booked: 0, recorded: 0, editing: 2, published: 0 });
  });
});

describe('prep checklist', () => {
  test('has the five prep items', () => {
    assert.deepEqual(L.CHECKS.map((c) => c.key), ['call', 'bio', 'kit', 'release', 'promo']);
  });

  test('prepProgress reports done / total / pct', () => {
    assert.deepEqual(L.prepProgress(guest()), { done: 0, total: 5, pct: 0, complete: false });
    const g = guest({ checks: { call: true, bio: true } });
    assert.deepEqual(L.prepProgress(g), { done: 2, total: 5, pct: 40, complete: false });
    const all = guest({ checks: { call: true, bio: true, kit: true, release: true, promo: true } });
    assert.equal(L.prepProgress(all).complete, true);
  });

  test('toggleCheck flips one item and validates the key', () => {
    const g = L.toggleCheck(guest(), 'kit');
    assert.equal(g.checks.kit, true);
    assert.equal(L.toggleCheck(g, 'kit').checks.kit, false);
    assert.throws(() => L.toggleCheck(g, 'bogus'));
  });
});

describe('guests', () => {
  test('initials handles one, many and empty names', () => {
    assert.equal(L.initials('Lena Brandt'), 'LB');
    assert.equal(L.initials('Aiko'), 'A');
    assert.equal(L.initials('  mary   ann   smith '), 'MS');
    assert.equal(L.initials(''), '?');
    assert.equal(L.initials('Émile Zola'), 'ÉZ');
  });

  test('normalizeGuest fills defaults and drops junk', () => {
    const g = L.normalizeGuest({ name: 42, stage: 'weird', checks: { call: 'yes', bio: true, extra: true }, recordingAt: 'not a date', availability: ['2026-10-05T10:00', 'bad', '2026-10-05T10:00'] }, { idFn });
    assert.equal(g.name, '42');
    assert.equal(g.stage, 'outreach');
    assert.deepEqual(g.checks, { call: false, bio: true, kit: false, release: false, promo: false });
    assert.equal(g.recordingAt, '');
    assert.deepEqual(g.availability, ['2026-10-05T10:00']);
    assert.equal(g.sample, false);
    assert.ok(g.id);
  });

  test('normalizeGuest trims seconds from recording times', () => {
    assert.equal(L.normalizeGuest({ recordingAt: '2026-10-06T14:00:30' }, { idFn }).recordingAt, '2026-10-06T14:00');
  });

  test('updateGuestField only accepts known fields', () => {
    const g = L.updateGuestField(guest(), 'topic', 'Tides', NOW);
    assert.equal(g.topic, 'Tides');
    assert.throws(() => L.updateGuestField(g, 'stage', 'booked'));
  });

  test('filterGuests matches name, topic or role, case-insensitively', () => {
    const list = [
      guest({ name: 'Lena Brandt', role: 'Author', topic: 'Boredom' }),
      guest({ name: 'Priya Shah', role: 'Sleep researcher', topic: 'Night waking' }),
      guest({ name: 'Tomás Ibarra', role: 'Chef', topic: 'Zero-waste kitchen' })
    ];
    assert.deepEqual(L.filterGuests(list, 'lena').map((g) => g.name), ['Lena Brandt']);
    assert.deepEqual(L.filterGuests(list, 'KITCHEN').map((g) => g.name), ['Tomás Ibarra']);
    assert.deepEqual(L.filterGuests(list, 'researcher').map((g) => g.name), ['Priya Shah']);
    assert.deepEqual(L.filterGuests(list, 'sleep night').map((g) => g.name), ['Priya Shah']);
    assert.equal(L.filterGuests(list, '   ').length, 3);
    assert.equal(L.filterGuests(list, 'nobody').length, 0);
  });
});

describe('sorting', () => {
  const list = () => [
    guest({ name: 'charlie', stage: 'published', recordingAt: '2026-09-01T10:00' }),
    guest({ name: 'Alice', stage: 'booked', recordingAt: '2026-10-10T09:00' }),
    guest({ name: 'bob', stage: 'outreach' }),
    guest({ name: 'Dana', stage: 'booked', recordingAt: '2026-10-02T15:30' })
  ];

  test('by name, case-insensitive, both directions', () => {
    assert.deepEqual(L.sortGuests(list(), 'name').map((g) => g.name), ['Alice', 'bob', 'charlie', 'Dana']);
    assert.deepEqual(L.sortGuests(list(), 'name', 'desc').map((g) => g.name), ['Dana', 'charlie', 'bob', 'Alice']);
  });

  test('by stage follows pipeline order with name as tiebreak', () => {
    assert.deepEqual(L.sortGuests(list(), 'stage').map((g) => g.name), ['bob', 'Alice', 'Dana', 'charlie']);
    assert.deepEqual(L.sortGuests(list(), 'stage', 'desc').map((g) => g.name), ['charlie', 'Alice', 'Dana', 'bob']);
  });

  test('by recording date keeps unscheduled guests last in both directions', () => {
    assert.deepEqual(L.sortGuests(list(), 'recording').map((g) => g.name), ['charlie', 'Dana', 'Alice', 'bob']);
    assert.deepEqual(L.sortGuests(list(), 'recording', 'desc').map((g) => g.name), ['Alice', 'Dana', 'charlie', 'bob']);
  });

  test('does not mutate the input and rejects unknown keys', () => {
    const l = list();
    const before = l.map((g) => g.name);
    L.sortGuests(l, 'name');
    assert.deepEqual(l.map((g) => g.name), before);
    assert.throws(() => L.sortGuests(l, 'email'));
  });
});

describe('dates', () => {
  test('parseLocal validates ranges', () => {
    assert.deepEqual(L.parseLocal('2026-10-06T14:05'), { y: 2026, m: 10, d: 6, hh: 14, mm: 5, hasTime: true });
    assert.equal(L.parseLocal('2026-02-29'), null);
    assert.ok(L.parseLocal('2028-02-29'));
    assert.equal(L.parseLocal('2026-13-01'), null);
    assert.equal(L.parseLocal('2026-10-06T24:00'), null);
    assert.equal(L.parseLocal(''), null);
    assert.equal(L.parseLocal(undefined), null);
  });

  test('formatting matches the mockup style', () => {
    assert.equal(L.formatRecording('2026-10-06T14:00'), 'Tue Oct 6 · 2:00 PM');
    assert.equal(L.formatRecording('2026-10-08T00:30'), 'Thu Oct 8 · 12:30 AM');
    assert.equal(L.formatTime('2026-10-08T12:00'), '12:00 PM');
    assert.equal(L.formatDay('2026-10-05T10:00'), 'Mon, Oct 5');
    assert.equal(L.formatShortDate('2026-09-24T10:00'), 'Sep 24');
    assert.equal(L.formatRecording(''), '');
    assert.equal(L.monthLabel(2026, 10), 'October 2026');
  });

  test('addDays crosses months, years and keeps the time', () => {
    assert.equal(L.addDays('2026-09-28', 5), '2026-10-03');
    assert.equal(L.addDays('2026-12-31T09:15', 1), '2027-01-01T09:15');
    assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
  });

  test('shiftMonth wraps years', () => {
    assert.deepEqual(L.shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
    assert.deepEqual(L.shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
    assert.deepEqual(L.shiftMonth(2026, 5, -17), { year: 2024, month: 12 });
  });

  test('nowInZone returns wall-clock time in the given zone', () => {
    const d = new Date('2026-09-28T23:30:00Z');
    assert.equal(L.nowInZone('UTC', d), '2026-09-28T23:30');
    assert.equal(L.nowInZone('Europe/Berlin', d), '2026-09-29T01:30');
    assert.equal(L.nowInZone('America/New_York', d), '2026-09-28T19:30');
    assert.equal(L.isValidTimeZone('Mars/Olympus'), false);
    assert.equal(L.isValidTimeZone('Asia/Tokyo'), true);
  });

  test('groupByDay buckets by day, sorted by time, skipping unscheduled', () => {
    const a = guest({ name: 'A', recordingAt: '2026-10-06T14:00' });
    const b = guest({ name: 'B', recordingAt: '2026-10-06T09:00' });
    const c = guest({ name: 'C', recordingAt: '2026-10-08T11:00' });
    const d = guest({ name: 'D' });
    const groups = L.groupByDay([a, b, c, d]);
    assert.deepEqual(Object.keys(groups).sort(), ['2026-10-06', '2026-10-08']);
    assert.deepEqual(groups['2026-10-06'].map((g) => g.name), ['B', 'A']);
  });

  test('monthGrid produces full weeks starting on Sunday', () => {
    const weeks = L.monthGrid(2026, 10);
    assert.equal(weeks.length, 5);
    assert.ok(weeks.every((w) => w.length === 7));
    // Oct 1 2026 is a Thursday
    assert.equal(weeks[0][0].ymd, '2026-09-27');
    assert.equal(weeks[0][0].inMonth, false);
    assert.deepEqual(weeks[0][4], { ymd: '2026-10-01', day: 1, inMonth: true });
    const inMonth = weeks.flat().filter((c) => c.inMonth);
    assert.equal(inMonth.length, 31);
    assert.equal(inMonth.at(-1).ymd, '2026-10-31');
  });

  test('monthGrid supports Monday starts and six-week months', () => {
    const weeks = L.monthGrid(2026, 8, 1); // Aug 1 2026 is a Saturday
    assert.equal(weeks[0][0].ymd, '2026-07-27');
    assert.equal(weeks.length, 6);
    const feb = L.monthGrid(2026, 2); // Feb 1 2026 is a Sunday, 28 days
    assert.equal(feb.length, 4);
  });

  test('suggestSlots gives next Mon/Wed/Fri at two times', () => {
    // 2026-09-28 is a Monday, so the next ones are Wed 30, Fri Oct 2, Mon Oct 5
    assert.deepEqual(L.suggestSlots('2026-09-28'), [
      '2026-09-30T10:00', '2026-09-30T14:00',
      '2026-10-02T10:00', '2026-10-02T14:00',
      '2026-10-05T10:00', '2026-10-05T14:00'
    ]);
  });
});

describe('templates', () => {
  test('the default templates use only the documented placeholders', () => {
    assert.deepEqual(L.DEFAULT_TEMPLATES.map((t) => t.name), ['Invitation', 'Booking confirmation', 'Recording reminder', 'Thank-you + episode link', 'Availability request', 'Pre-interview questions']);
    for (const t of L.DEFAULT_TEMPLATES) {
      for (const [, key] of `${t.subject} ${t.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        assert.ok(L.PLACEHOLDERS.includes(key), `${t.id} uses unknown placeholder ${key}`);
      }
    }
  });

  test('renderTemplate replaces known placeholders, tolerates spaces, keeps unknown ones', () => {
    const out = L.renderTemplate('Hi {{guest_name}}, {{ show_name }} at {{recording_time}} {{nope}}', { guest_name: 'Lena', show_name: 'Deep Air', recording_time: 'Tue' });
    assert.equal(out, 'Hi Lena, Deep Air at Tue {{nope}}');
  });

  test('renderTemplate does not interpret $ patterns in values', () => {
    assert.equal(L.renderTemplate('{{guest_name}}', { guest_name: "$& $1 $'" }), "$& $1 $'");
  });

  test('templateVars uses host time zone and friendly fallbacks', () => {
    const settings = { showName: 'Deep Air', timeZone: 'Europe/Berlin' };
    const v = L.templateVars(guest({ name: 'Lena Brandt', recordingAt: '2026-10-06T14:00', episodeLink: 'https://x.test/1' }), settings);
    assert.deepEqual(v, { guest_name: 'Lena Brandt', recording_time: 'Tue Oct 6 · 2:00 PM (Europe/Berlin)', show_name: 'Deep Air', episode_link: 'https://x.test/1', availability_link: '[availability link]', qa_link: '[questions link]' });
    const empty = L.templateVars(guest({ name: '' }), {});
    assert.equal(empty.guest_name, 'there');
    assert.equal(empty.recording_time, 'a time to be confirmed');
    assert.equal(empty.show_name, 'our show');
  });

  test('renderEmail renders subject and body', () => {
    const t = L.DEFAULT_TEMPLATES.find((x) => x.id === 'booking');
    const e = L.renderEmail(t, guest({ name: 'Lena', recordingAt: '2026-10-06T14:00' }), { showName: 'Deep Air', timeZone: 'UTC' });
    assert.equal(e.subject, "You're booked on Deep Air: Tue Oct 6 · 2:00 PM (UTC)");
    assert.match(e.body, /^Hi Lena,/);
    assert.doesNotMatch(e.body, /\{\{/);
  });

  test('buildMailto encodes subject/body with CRLF line breaks', () => {
    const url = L.buildMailto('lena@example.com', 'Hi & welcome', 'Line 1\nLine 2');
    assert.equal(url, 'mailto:lena@example.com?subject=Hi%20%26%20welcome&body=Line%201%0D%0ALine%202');
    assert.equal(L.buildMailto('', 'S'), 'mailto:?subject=S');
  });

  test('normalizeTemplates keeps edits and restores missing defaults', () => {
    const t = L.normalizeTemplates([{ id: 'invitation', subject: 'Custom', body: 'B' }, { id: 'rogue', subject: 'x', body: 'y' }]);
    assert.equal(t.length, L.DEFAULT_TEMPLATES.length);
    assert.equal(t[0].subject, 'Custom');
    assert.equal(t[1].subject, L.DEFAULT_TEMPLATES[1].subject);
    assert.ok(!t.some((x) => x.id === 'rogue'));
  });
});

describe('storage serialization', () => {
  test('initial state has settings, templates and labelled samples', () => {
    const s = L.createInitialState({ timeZone: 'Europe/Berlin', today: '2026-09-28', idFn });
    assert.equal(s.settings.timeZone, 'Europe/Berlin');
    assert.equal(s.templates.length, L.DEFAULT_TEMPLATES.length);
    assert.ok(s.guests.length >= 5);
    assert.ok(s.guests.every((g) => g.sample === true));
    for (const id of L.STAGE_IDS) assert.ok(s.guests.some((g) => g.stage === id), `sample for ${id}`);
    const lena = s.guests.find((g) => g.name === 'Lena Brandt');
    assert.equal(lena.recordingAt, '2026-10-06T14:00');
  });

  test('initial state without samples is empty', () => {
    assert.equal(L.createInitialState({ withSamples: false }).guests.length, 0);
  });

  test('serialize -> parse round-trips', () => {
    const s = L.createInitialState({ timeZone: 'UTC', today: '2026-09-28', idFn });
    s.settings.showName = 'Deep Air';
    s.templates[0].subject = 'Edited';
    const json = L.serializeState(s, NOW);
    const parsed = L.parseState(json, { idFn });
    assert.deepEqual(parsed.guests, s.guests);
    assert.deepEqual(parsed.settings, s.settings);
    assert.deepEqual(parsed.templates, s.templates);
    assert.equal(JSON.parse(json).exportedAt, NOW);
    assert.equal(JSON.parse(json).app, 'podcast-guest-manager');
  });

  test('parseState rejects bad input with readable messages', () => {
    assert.throws(() => L.parseState('{nope'), /not valid JSON/);
    assert.throws(() => L.parseState('[]'), /backup object/);
    assert.throws(() => L.parseState('{"settings":{}}'), /no guest list/);
    assert.throws(() => L.parseState('{"app":"other","guests":[]}'), /different app/);
    assert.throws(() => L.parseState('{"version":99,"guests":[]}'), /newer version/);
  });

  test('parseState repairs duplicate ids and bad settings', () => {
    const s = L.parseState({ guests: [{ id: 'a', name: 'One' }, { id: 'a', name: 'Two' }], settings: { timeZone: 'Nowhere/City', intakeSlots: ['2026-10-05T10:00', 'x', '2026-10-05'] } }, { idFn, timeZone: 'UTC' });
    assert.notEqual(s.guests[0].id, s.guests[1].id);
    assert.equal(s.settings.timeZone, 'UTC');
    assert.equal(s.settings.showName, 'My Podcast');
    assert.deepEqual(s.settings.intakeSlots, ['2026-10-05T10:00']);
    assert.equal(s.templates.length, L.DEFAULT_TEMPLATES.length);
  });

  test('upsert, remove and clearSamples', () => {
    let s = L.createInitialState({ today: '2026-09-28', idFn });
    const g = guest({ name: 'Real Guest' });
    s = L.upsertGuest(s, g);
    assert.ok(L.hasSamples(s));
    s = L.upsertGuest(s, { ...g, topic: 'Updated' });
    assert.equal(s.guests.filter((x) => x.id === g.id).length, 1);
    assert.equal(s.guests.find((x) => x.id === g.id).topic, 'Updated');
    s = L.clearSamples(s);
    assert.deepEqual(s.guests.map((x) => x.name), ['Real Guest']);
    assert.equal(L.hasSamples(s), false);
    s = L.removeGuest(s, g.id);
    assert.equal(s.guests.length, 0);
  });
});

describe('intake', () => {
  const answers = {
    name: '  Sam Rivera ', pronouns: 'they/them', role: 'Birder', topic: 'City owls', email: 'sam@example.com',
    social: 'https://sam.example', bio: 'Sam watches owls.', headshot: 'sam.jpg', setup: 'remote-own',
    availability: ['2026-10-07T16:00', '2026-10-05T10:00'], notes: 'Promoting a zine.', consent: true
  };

  test('validateIntake requires name and a plausible email', () => {
    assert.deepEqual(L.validateIntake(answers), {});
    const e = L.validateIntake({ name: ' ', email: 'nope' });
    assert.ok(e.name && e.email);
  });

  test('intakeToGuest builds an Outreach guest with prep ticks', () => {
    const g = L.intakeToGuest(answers, { idFn, nowIso: NOW });
    assert.equal(g.name, 'Sam Rivera');
    assert.equal(g.stage, 'outreach');
    assert.equal(g.source, 'intake');
    assert.deepEqual(g.availability, ['2026-10-05T10:00', '2026-10-07T16:00']);
    assert.equal(g.checks.bio, false, 'a file name alone is not a received headshot');
    assert.equal(g.checks.release, true);
    assert.equal(g.checks.call, false);
    assert.match(g.notes, /Remote, own mic/);
    assert.match(g.notes, /Promoting a zine/);
    assert.equal(g.sample, false);
  });

  test('intakeToGuest can reuse an id so re-submitting updates the same guest', () => {
    assert.equal(L.intakeToGuest(answers, { id: 'fixed' }).id, 'fixed');
  });

  test('intakeToText lists everything in plain text', () => {
    const text = L.intakeToText(answers, { showName: 'Deep Air', timeZone: 'Europe/Berlin' });
    assert.match(text, /Guest intake for Deep Air/);
    assert.match(text, /Times that work \(Europe\/Berlin\):\n- Mon, Oct 5, 10:00 AM\n- Wed, Oct 7, 4:00 PM/);
    assert.match(text, /Recording setup: Remote, own mic/);
    assert.match(text, /Agrees to publication and promo clips: Yes/);
  });

  test('intake URL round-trips host settings and drops invalid values', () => {
    const url = L.buildIntakeUrl('https://x.test/guest-manager/intake.html', { showName: 'Deep Air & Co', timeZone: 'Europe/Berlin', hostEmail: 'host@x.test', intakeSlots: ['2026-10-05T10:00'] });
    const read = L.readIntakeParams(new URL(url).search);
    assert.deepEqual(read, { showName: 'Deep Air & Co', timeZone: 'Europe/Berlin', hostEmail: 'host@x.test', intakeSlots: ['2026-10-05T10:00'] });
    assert.deepEqual(L.readIntakeParams('?tz=Bad/Zone&to=notanemail&slots=junk'), {});
  });
});

// Loads backend/Code.gs in a vm with stubbed Apps Script services, to test
// validation, the honeypot, rate limiting, storage and doGet's key check.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const code = readFileSync(new URL('../backend/Code.gs', import.meta.url), 'utf8');

function makeSheet(name) {
  const rows = [];
  return {
    name, rows,
    appendRow(r) { rows.push(r.slice()); },
    getLastRow() { return rows.length; },
    setFrozenRows() {},
    getDataRange() { return { getValues: () => rows.map((r) => r.slice()) }; }
  };
}

function makeEnv() {
  const props = new Map();
  const cache = new Map();
  const sheets = new Map();
  const files = [];
  const mail = [];
  const ss = {
    getId: () => 'sheet-1',
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; }
  };
  const folder = { getId: () => 'folder-1', createFile: (blob) => { files.push(blob); return { getUrl: () => `https://drive.google.com/file/d/${files.length}/view` }; } };
  const ctx = {
    console: { log() {}, error() {} },
    JSON, Math, Date, String, Number, Object, Array, RegExp, Error, isNaN,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    DriveApp: { createFolder: () => folder, getFolderById: () => folder },
    MailApp: { sendEmail: (m) => mail.push(m) },
    Utilities: {
      getUuid: () => randomUUID(),
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      computeDigest: (_alg, text) => [...createHash('sha256').update(text).digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }
    },
    ContentService: { createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } }
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return { ctx, props, cache, sheets, files, mail };
}

const post = (env, body) => JSON.parse(env.ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
const get = (env, parameter) => JSON.parse(env.ctx.doGet({ parameter }).text);
const intake = (over = {}) => ({ type: 'intake', name: 'Sam Rivera', email: 'sam@example.com', bio: 'Owls.', availability: ['2026-10-05T10:00'], consent: true, timeZone: 'Europe/Berlin', ...over });

describe('Code.gs', () => {
  let env;
  beforeEach(() => {
    env = makeEnv();
    env.ctx.setup();
  });

  test('setup creates the three sheets with headers and a long READ_KEY', () => {
    assert.deepEqual([...env.sheets.keys()].sort(), ['Availability', 'QA', 'Submissions']);
    assert.equal(env.sheets.get('Submissions').rows[0][0], 'id');
    assert.ok(env.props.get('READ_KEY').length >= 32);
    const again = env.ctx.setup();
    assert.equal(again, env.props.get('READ_KEY'), 'setup is safe to re-run');
  });

  test('validateSubmission_ requires name and a valid email, and limits lengths', () => {
    const v = env.ctx.validateSubmission_;
    assert.equal(v(intake()).ok, true);
    assert.match(v(intake({ name: '' })).error, /Name is required/);
    assert.match(v(intake({ email: 'nope' })).error, /Email is not valid/);
    assert.match(v(intake({ bio: 'x'.repeat(2001) })).error, /too long/);
    assert.match(v(intake({ availability: ['tomorrow'] })).error, /invalid time/);
    assert.match(v({ ...intake(), type: 'weird' }).error, /Unknown/);
    assert.match(v(intake({ name: { a: 1 } })).error, /not text/);
  });

  test('headshot checks type and size', () => {
    const v = env.ctx.validateHeadshot_;
    assert.equal(v({ type: 'image/jpeg', data: Buffer.from('abc').toString('base64'), name: 'me.jpg' }).ok, true);
    assert.match(v({ type: 'text/html', data: 'aGk=' }).error, /JPEG/);
    assert.match(v({ type: 'image/jpeg', data: 'not base64!' }).error, /not valid/);
    const big = Buffer.alloc(1.6 * 1024 * 1024).toString('base64');
    assert.match(v({ type: 'image/jpeg', data: big }).error, /too large/);
  });

  test('doPost stores an intake row, saves the headshot to Drive, returns the id', () => {
    const r = post(env, intake({ headshot: { name: 'me.jpg', type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') } }));
    assert.equal(r.ok, true);
    assert.match(r.id, /^s_/);
    const rows = env.sheets.get('Submissions').rows;
    assert.equal(rows.length, 2);
    const rec = Object.fromEntries(rows[0].map((h, i) => [h, rows[1][i]]));
    assert.equal(rec.id, r.id);
    assert.equal(rec.email, 'sam@example.com');
    assert.equal(rec.availability, '2026-10-05T10:00');
    assert.match(rec.headshotUrl, /^https:\/\/drive\.google\.com/);
    assert.equal(env.files.length, 1);
    assert.ok(rec.submittedAt instanceof Date || typeof rec.submittedAt === 'object');
  });

  test('bad JSON, oversized bodies and invalid input are rejected with a message', () => {
    assert.equal(post(env, '{nope').ok, false);
    assert.match(post(env, intake({ email: '' })).error, /Email is required/);
    assert.match(post(env, 'x'.repeat(3 * 1024 * 1024)).error, /too large/);
  });

  test('honeypot submissions look successful but are not stored', () => {
    const r = post(env, intake({ hp_website: 'http://spam.test' }));
    assert.equal(r.ok, true);
    assert.equal(env.sheets.get('Submissions').rows.length, 1);
  });

  test('per-email rate limit', () => {
    for (let i = 0; i < 5; i++) assert.equal(post(env, intake()).ok, true);
    const r = post(env, intake({ email: 'SAM@example.com' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /Too many/);
    assert.equal(post(env, intake({ email: 'other@example.com' })).ok, true);
  });

  test('formula-looking text is stored as text and read back unchanged', () => {
    post(env, intake({ notes: '=HYPERLINK("http://evil")', name: '+Sam' }));
    const row = env.sheets.get('Submissions').rows[1];
    assert.ok(row.includes('\'=HYPERLINK("http://evil")'));
    const list = get(env, { action: 'list', key: env.props.get('READ_KEY') });
    assert.equal(list.submissions[0].notes, '=HYPERLINK("http://evil")');
    assert.equal(list.submissions[0].name, '+Sam');
  });

  test('doGet without a valid key returns only the health check', () => {
    post(env, intake());
    for (const p of [{}, { action: 'list' }, { action: 'list', key: 'wrong' }, { action: 'list', key: env.props.get('READ_KEY').slice(1) + 'x' }]) {
      assert.deepEqual(get(env, p), { ok: true, service: 'guest-intake' });
    }
  });

  test('doGet with no READ_KEY configured never returns data', () => {
    env.props.delete('READ_KEY');
    post(env, intake());
    assert.deepEqual(get(env, { action: 'list', key: '' }), { ok: true, service: 'guest-intake' });
  });

  test('doGet list returns all types, typed, filtered by since', () => {
    const key = env.props.get('READ_KEY');
    post(env, intake());
    post(env, { type: 'availability', name: 'Sam', email: 'sam2@example.com', guestId: 'g_1', slots: ['2026-10-06T14:30', '2026-10-06T14:00'], timeZone: 'UTC', guestTimeZone: 'America/New_York' });
    post(env, { type: 'qa', name: 'Sam', email: 'sam3@example.com', guestId: 'g_1', answers: [{ id: 'q1', question: 'Intro?', answer: 'Hi' }], topics: 'Owls' });
    const all = get(env, { action: 'list', key });
    assert.equal(all.ok, true);
    assert.ok(all.now);
    assert.deepEqual(all.submissions.map((s) => s.type).sort(), ['availability', 'intake', 'qa']);
    const av = all.submissions.find((s) => s.type === 'availability');
    assert.equal(av.slots, '2026-10-06T14:00, 2026-10-06T14:30');
    const qa = all.submissions.find((s) => s.type === 'qa');
    assert.deepEqual(qa.answers, [{ id: 'q1', question: 'Intro?', answer: 'Hi' }]);
    assert.equal(all.submissions.find((s) => s.type === 'intake').consent, true);
    const later = get(env, { action: 'list', key, since: new Date(Date.now() + 60000).toISOString() });
    assert.equal(later.submissions.length, 0);
  });

  test('availability and qa need content', () => {
    assert.match(post(env, { type: 'availability', name: 'A', email: 'a@b.co', slots: [] }).error, /free time/);
    assert.match(post(env, { type: 'qa', name: 'A', email: 'a@b.co', answers: [{ id: 'q1', answer: '' }] }).error, /at least one/);
  });

  test('notifications go only to NOTIFY_EMAIL from Script Properties', () => {
    post(env, intake({ show: 'Evil Show', to: 'attacker@evil.test' }));
    assert.equal(env.mail.length, 0);
    env.props.set('NOTIFY_EMAIL', 'host@example.com');
    post(env, intake({ show: 'Evil Show', email: 'b@example.com' }));
    assert.equal(env.mail.length, 1);
    assert.equal(env.mail[0].to, 'host@example.com');
    assert.match(env.mail[0].subject, /^My Podcast:/);
  });

  test('rotateReadKey replaces the key', () => {
    const old = env.props.get('READ_KEY');
    const fresh = env.ctx.rotateReadKey();
    assert.notEqual(fresh, old);
    post(env, intake());
    assert.deepEqual(get(env, { action: 'list', key: old }), { ok: true, service: 'guest-intake' });
    assert.equal(get(env, { action: 'list', key: fresh }).submissions.length, 1);
  });
});

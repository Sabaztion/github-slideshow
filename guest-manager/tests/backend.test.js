// Loads backend/Code.gs in a vm with stubbed Apps Script services, to test
// validation, the honeypot, rate limiting, storage and doGet's key check.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const code = readFileSync(new URL('../backend/Code.gs', import.meta.url), 'utf8');

function makeSheet(name) {
  const rows = []; // 2D array of values, row 1 = headers
  const formats = new Map(); // "r,c" -> number format
  let maxRows = 1000;
  const width = () => rows.reduce((m, r) => Math.max(m, r.length), 0);
  const sheet = {
    name, rows, formats, calls: { getRange: 0 },
    getLastRow() { return rows.length; },
    getLastColumn() { return width(); },
    getMaxRows() { return maxRows; },
    insertRowsAfter(_after, n) { maxRows += n; },
    setFrozenRows() {},
    getDataRange() { return sheet.getRange(1, 1, rows.length, width()); },
    getRange(r, c, nr = 1, nc = 1) {
      sheet.calls.getRange += 1;
      return {
        rows: nr,
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
        setValues: (vals) => {
          vals.forEach((row, i) => {
            const target = rows[r - 1 + i] || (rows[r - 1 + i] = []);
            row.forEach((v, j) => { target[c - 1 + j] = v; });
          });
        },
        setNumberFormat: (f) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) formats.set(`${r + i},${c + j}`, f); },
        setNumberFormats: (fs) => fs.forEach((row, i) => row.forEach((f, j) => formats.set(`${r + i},${c + j}`, f)))
      };
    }
  };
  return sheet;
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)), deleteProperty: (k) => props.delete(k), getProperties: () => Object.fromEntries(props) }) },
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
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64');
    assert.equal(v({ type: 'image/jpeg', data: jpeg, name: 'me.jpg' }).ok, true);
    assert.equal(v({ type: 'image/png', data: png }).ok, true);
    assert.equal(v({ type: 'image/webp', data: webp }).ok, true);
    assert.match(v({ type: 'image/jpeg', data: Buffer.from('<html><script>').toString('base64') }).error, /don’t match/, 'magic bytes are checked');
    assert.match(v({ type: 'image/png', data: jpeg }).error, /don’t match/);
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

  test('single-line fields lose control characters; token and UTC slots are stored', () => {
    const r = env.ctx.validateSubmission_({ type: 'availability', name: 'Sam\r\nBcc: x@evil.test', email: 'sam@example.com\u0000', token: 'tabcdef0123456789abcdef', slotsUtc: ['2026-10-25T00:30Z', '2026-10-25T01:30Z'], show: 'Show\u0007' });
    assert.equal(r.ok, true);
    assert.equal(r.value.name, 'Sam Bcc: x@evil.test');
    assert.equal(r.value.email, 'sam@example.com');
    assert.equal(r.value.linkShow, 'Show');
    assert.equal(r.value.token, 'tabcdef0123456789abcdef');
    assert.deepEqual([...r.value.slotsUtc], ['2026-10-25T00:30Z', '2026-10-25T01:30Z']);
    assert.match(env.ctx.validateSubmission_({ type: 'availability', name: 'A', email: 'a@b.co', slotsUtc: ['tomorrow'] }).error, /invalid time/);
    assert.equal(env.ctx.validateSubmission_({ ...intake(), token: 'short' }).value.token, '');
    post(env, { type: 'availability', name: 'Sam', email: 'sam@example.com', token: 'tabcdef0123456789abcdef', slotsUtc: ['2026-10-25T00:30Z'], timeZone: 'Europe/Berlin' });
    const got = get(env, { action: 'list', key: env.props.get('READ_KEY') }).submissions[0];
    assert.equal(got.token, 'tabcdef0123456789abcdef');
    assert.equal(got.slotsUtc, '2026-10-25T00:30Z');
  });

  test('data columns are plain text so Sheets never converts values; rows are written with setValues', () => {
    const sheet = env.sheets.get('Submissions');
    const headers = sheet.rows[0];
    headers.forEach((h, i) => assert.equal(sheet.formats.get(`1,${i + 1}`), h === 'submittedAt' ? 'yyyy-mm-dd hh:mm:ss' : '@', h));
    post(env, intake({ notes: '3/4', pronouns: 'TRUE', role: '0012' }));
    headers.forEach((h, i) => assert.equal(sheet.formats.get(`2,${i + 1}`), h === 'submittedAt' ? 'yyyy-mm-dd hh:mm:ss' : '@'));
    const rec = Object.fromEntries(headers.map((h, i) => [h, sheet.rows[1][i]]));
    assert.equal(rec.notes, '3/4');
    assert.equal(rec.role, '0012');
  });

  test('sheets from an older version get the new columns added, and rows follow the sheet’s own order', () => {
    const e2 = makeEnv();
    const old = e2.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Availability');
    old.rows.push(['id', 'submittedAt', 'type', 'guestId', 'name', 'email', 'timeZone', 'guestTimeZone', 'slots', 'notes', 'linkShow']);
    old.rows.push(['s_old', new Date('2026-09-01T00:00:00Z'), 'availability', '', 'Old', 'old@example.com', 'UTC', '', '2026-10-01T10:00', '', '']);
    e2.ctx.setup();
    assert.deepEqual(old.rows[0].slice(-2), ['token', 'slotsUtc']);
    post(e2, { type: 'availability', name: 'New', email: 'new@example.com', token: 'tabcdef0123456789abcdef', slots: ['2026-10-02T10:00'] });
    const list = get(e2, { action: 'list', key: e2.props.get('READ_KEY') }).submissions;
    assert.equal(list.length, 2);
    assert.equal(list[1].token, 'tabcdef0123456789abcdef');
    assert.equal(list[0].slots, '2026-10-01T10:00');
  });

  test('listing with since reads only the newer rows', () => {
    const sheet = env.sheets.get('Submissions');
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 500; i++) sheet.rows.push(['s_' + i, new Date(base + i * 60000), 'intake', 'N', '', `n${i}@x.co`]);
    const before = sheet.calls.getRange;
    const res = get(env, { action: 'list', key: env.props.get('READ_KEY'), since: new Date(base + 497 * 60000).toISOString() });
    assert.deepEqual(res.submissions.map((x) => x.id), ['s_498', 's_499']);
    assert.ok(sheet.calls.getRange - before <= 4, 'a few small reads, not the whole sheet');
  });

  test('daily caps bound submissions, photos and notifications', () => {
    env.ctx.DAILY.submissions = 3;
    env.ctx.DAILY.headshots = 1;
    env.ctx.DAILY.notifications = 2;
    env.props.set('NOTIFY_EMAIL', 'host@example.com');
    const photo = { name: 'me.jpg', type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') };
    assert.equal(post(env, intake({ email: 'a1@x.co', headshot: photo })).ok, true);
    const second = post(env, intake({ email: 'a2@x.co', headshot: photo }));
    assert.equal(second.ok, true);
    assert.equal(second.note, 'photo-not-saved');
    assert.equal(env.files.length, 1);
    assert.equal(post(env, intake({ email: 'a3@x.co' })).ok, true);
    const fourth = post(env, intake({ email: 'a4@x.co' }));
    assert.equal(fourth.ok, false);
    assert.match(fourth.error, /too many submissions today/);
    assert.equal(env.mail.length, 2);
    assert.match(env.mail[1].body, /last notification today/);
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

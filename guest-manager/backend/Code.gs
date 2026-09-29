/**
 * Podcast Guest Manager: guest submissions backend (Google Apps Script).
 *
 * A free backend that lives in a Google Sheet you own. Guest pages
 * (intake.html, availability.html, qa.html) POST their answers here; the
 * guest manager app reads them back with a secret read key.
 *
 * DEPLOY (about 5 minutes, see guest-manager/README.md for screenshots-free detail):
 *   1. Create a new Google Sheet (sheets.new). Name it, for example, "Guest intake".
 *   2. Extensions -> Apps Script. Delete the sample code, paste this whole file,
 *      and change SHOW_NAME below. Save.
 *   3. In the function menu pick `setup` and press Run. Approve the permissions
 *      (Sheets, Drive for headshots, and email only if you set NOTIFY_EMAIL).
 *      setup() creates the Submissions, Availability and QA sheets, the Drive
 *      folder "<SHOW_NAME> guest headshots", and a random READ_KEY. Open
 *      View -> Logs (or Executions) to copy the key.
 *   4. Deploy -> New deployment -> type "Web app".
 *        Execute as: Me.   Who has access: Anyone.
 *      Copy the web app URL (https://script.google.com/macros/s/.../exec).
 *   5. In the guest manager: Settings -> Intake backend. Paste the URL and the
 *      read key, press "Test connection", then share the links from Settings.
 *
 * SECURITY
 *   - Anyone with the URL can POST a submission (that's what lets guests send
 *     answers). Submissions are validated, size-limited, rate-limited per email,
 *     and a hidden honeypot field drops most bots.
 *   - Reading requires READ_KEY (Script Properties). Without a valid key, GET
 *     only returns a health check and never any data.
 *   - The show name and the notification address come from this script's own
 *     settings, never from the request, so a crafted share link can't change
 *     where notifications go.
 *   - Rotate the key: run rotateReadKey(), then paste the new key in Settings.
 *     Changing code needs Deploy -> Manage deployments -> Edit -> New version.
 */

/* ------------------------------------------------------------------ */
/* Settings you can change                                             */
/* ------------------------------------------------------------------ */

var SHOW_NAME = 'My Podcast';

/* ------------------------------------------------------------------ */
/* Limits (keep in sync with LIMITS in js/remote.js)                   */
/* ------------------------------------------------------------------ */

var LIMITS = {
  name: 120, pronouns: 60, email: 254, social: 300, role: 160, topic: 300, bio: 2000, notes: 2000,
  setup: 40, timeZone: 64, show: 120, guestId: 64, headshotName: 200, availability: 30,
  slots: 1000, answers: 20, question: 300, answer: 2000, topics: 2000,
  headshotBytes: 1.5 * 1024 * 1024, // decoded size
  body: 2.5 * 1024 * 1024, // whole request body, characters
  cell: 45000 // Sheets allows 50,000 characters per cell
};

var RATE_LIMIT = { perEmail: 5, windowSeconds: 600, global: 60, globalWindowSeconds: 60 };

var SHEETS = {
  intake: {
    name: 'Submissions',
    headers: ['id', 'submittedAt', 'type', 'name', 'pronouns', 'email', 'social', 'role', 'topic', 'bio',
      'availability', 'timeZone', 'setup', 'notes', 'consent', 'headshotName', 'headshotUrl', 'linkShow']
  },
  availability: {
    name: 'Availability',
    headers: ['id', 'submittedAt', 'type', 'guestId', 'name', 'email', 'timeZone', 'guestTimeZone', 'slots', 'notes', 'linkShow']
  },
  qa: {
    name: 'QA',
    headers: ['id', 'submittedAt', 'type', 'guestId', 'name', 'email', 'answers', 'topics', 'linkShow']
  }
};

var HONEYPOT_FIELD = 'hp_website';
var SERVICE = 'guest-intake';

/* ------------------------------------------------------------------ */
/* Web app entry points                                                */
/* ------------------------------------------------------------------ */

/** Guest pages POST JSON (sent as text/plain to avoid a CORS preflight). */
function doPost(e) {
  return json_(handlePost_(e));
}

/**
 * GET with ?action=list&key=<READ_KEY>&since=<ISO time> returns submissions.
 * Anything else, including a wrong key, returns only the health check.
 */
function doGet(e) {
  return json_(handleGet_(e));
}

function handlePost_(e) {
  try {
    var raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!raw) return fail_('Empty request.');
    if (raw.length > LIMITS.body) return fail_('The submission is too large.');
    var body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return fail_('The submission is not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail_('The submission is not valid.');

    // Honeypot: people never see this field. Pretend success so bots move on.
    if (String(body[HONEYPOT_FIELD] || '').trim()) return { ok: true, id: 'thanks' };

    var checked = validateSubmission_(body);
    if (!checked.ok) return fail_(checked.error);
    var s = checked.value;

    if (!rateLimitOk_(s.email)) return fail_('Too many submissions in a short time. Please wait a few minutes and try again.');

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var id = newId_();
      var now = new Date();
      if (s.type === 'intake' && s.headshot) {
        s.headshotUrl = saveHeadshot_(s.headshot, id, s.name);
      }
      appendRow_(s.type, rowFor_(s, id, now));
      notify_(s, id);
      return { ok: true, id: id };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return fail_('The server could not save the submission. Please try again later.');
  }
}

function handleGet_(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'list' && isAuthorized_(p.key)) {
    return { ok: true, service: SERVICE, now: new Date().toISOString(), submissions: listSubmissions_(p.since) };
  }
  return { ok: true, service: SERVICE };
}

/* ------------------------------------------------------------------ */
/* Validation (plain functions: unit-tested in tests/backend.test.js)  */
/* ------------------------------------------------------------------ */

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
var GUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var ITEM_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
var TZ_RE = /^[A-Za-z0-9_+\-\/]{1,64}$/;

/** Text field: string, trimmed, at most `max` characters, else an error. */
function text_(value, max, label, errors) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    errors.push(label + ' is not text.');
    return '';
  }
  var v = String(value).trim();
  if (v.length > max) errors.push(label + ' is too long (' + max + ' characters at most).');
  return v.slice(0, max);
}

function slots_(value, max, label, errors) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) {
    errors.push(label + ' must be a list.');
    return [];
  }
  if (value.length > max) errors.push('Too many ' + label + ' (' + max + ' at most).');
  var seen = {};
  var out = [];
  for (var i = 0; i < value.length && out.length < max; i++) {
    var s = String(value[i]);
    if (!SLOT_RE.test(s)) {
      errors.push(label + ' contains an invalid time.');
      break;
    }
    if (!seen[s]) {
      seen[s] = true;
      out.push(s);
    }
  }
  return out.sort();
}

/**
 * Check and clean a submission. Returns { ok: true, value } or
 * { ok: false, error }. The show name in the request is kept only as
 * "linkShow" for reference; the real show identity is SHOW_NAME.
 */
function validateSubmission_(body) {
  var errors = [];
  var type = body.type === undefined ? 'intake' : body.type;
  if (type !== 'intake' && type !== 'availability' && type !== 'qa') return { ok: false, error: 'Unknown submission type.' };
  var v = { type: type };
  v.name = text_(body.name, LIMITS.name, 'Name', errors);
  v.email = text_(body.email, LIMITS.email, 'Email', errors);
  v.linkShow = text_(body.show, LIMITS.show, 'Show', errors);
  if (!v.name) errors.push('Name is required.');
  if (!v.email) errors.push('Email is required.');
  else if (!EMAIL_RE.test(v.email)) errors.push('Email is not valid.');
  var tz = text_(body.timeZone, LIMITS.timeZone, 'Time zone', errors);
  v.timeZone = TZ_RE.test(tz) ? tz : '';

  if (type === 'intake') {
    v.pronouns = text_(body.pronouns, LIMITS.pronouns, 'Pronouns', errors);
    v.social = text_(body.social, LIMITS.social, 'Website', errors);
    v.role = text_(body.role, LIMITS.role, 'Role', errors);
    v.topic = text_(body.topic, LIMITS.topic, 'Topic', errors);
    v.bio = text_(body.bio, LIMITS.bio, 'Bio', errors);
    v.setup = text_(body.setup, LIMITS.setup, 'Setup', errors);
    v.notes = text_(body.notes, LIMITS.notes, 'Notes', errors);
    v.consent = body.consent === true;
    v.availability = slots_(body.availability, LIMITS.availability, 'times', errors);
    v.headshot = null;
    if (body.headshot) {
      var h = validateHeadshot_(body.headshot);
      if (!h.ok) errors.push(h.error);
      else v.headshot = h.value;
    }
  } else if (type === 'availability') {
    var gid = text_(body.guestId, LIMITS.guestId, 'Guest id', errors);
    v.guestId = GUEST_ID_RE.test(gid) ? gid : '';
    var gtz = text_(body.guestTimeZone, LIMITS.timeZone, 'Guest time zone', errors);
    v.guestTimeZone = TZ_RE.test(gtz) ? gtz : '';
    v.slots = slots_(body.slots, LIMITS.slots, 'free times', errors);
    v.notes = text_(body.notes, LIMITS.notes, 'Notes', errors);
    if (!v.slots.length) errors.push('Pick at least one free time.');
  } else {
    var qid = text_(body.guestId, LIMITS.guestId, 'Guest id', errors);
    v.guestId = GUEST_ID_RE.test(qid) ? qid : '';
    v.topics = text_(body.topics, LIMITS.topics, 'Topics', errors);
    v.answers = [];
    if (body.answers !== undefined && !Array.isArray(body.answers)) errors.push('Answers must be a list.');
    var list = Array.isArray(body.answers) ? body.answers : [];
    if (list.length > LIMITS.answers) errors.push('Too many answers (' + LIMITS.answers + ' at most).');
    for (var i = 0; i < list.length && i < LIMITS.answers; i++) {
      var a = list[i] || {};
      var aid = String(a.id || '');
      if (!ITEM_ID_RE.test(aid)) continue;
      v.answers.push({
        id: aid,
        question: text_(a.question, LIMITS.question, 'A question', errors),
        answer: text_(a.answer, LIMITS.answer, 'An answer', errors)
      });
    }
    var hasAnswer = v.topics !== '';
    for (var j = 0; j < v.answers.length; j++) if (v.answers[j].answer) hasAnswer = true;
    if (!hasAnswer) errors.push('Answer at least one question.');
    if (JSON.stringify(v.answers).length > LIMITS.cell) errors.push('The answers are too long in total.');
  }
  if (errors.length) return { ok: false, error: errors[0] };
  return { ok: true, value: v };
}

/** { name, type, data: base64 } -> { ok, value: { name, type, data } } with type and size checks. */
function validateHeadshot_(h) {
  if (typeof h !== 'object' || Array.isArray(h)) return { ok: false, error: 'The photo is not valid.' };
  var type = String(h.type || '');
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return { ok: false, error: 'The photo must be a JPEG, PNG or WebP image.' };
  var data = String(h.data || '');
  if (!data || !/^[A-Za-z0-9+\/]+={0,2}$/.test(data)) return { ok: false, error: 'The photo data is not valid.' };
  var pad = data.slice(-2) === '==' ? 2 : data.slice(-1) === '=' ? 1 : 0;
  var bytes = Math.floor(data.length * 3 / 4) - pad;
  if (bytes > LIMITS.headshotBytes) return { ok: false, error: 'The photo is too large (1.5 MB at most).' };
  var name = String(h.name || 'headshot').replace(/[^\w .-]/g, '').slice(0, LIMITS.headshotName) || 'headshot';
  return { ok: true, value: { name: name, type: type, data: data } };
}

/** Constant-time comparison of the supplied key with READ_KEY. */
function isAuthorized_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('READ_KEY') || '';
  var given = typeof key === 'string' ? key : '';
  if (expected.length < 16 || given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Up to RATE_LIMIT.perEmail submissions per email per window, plus a global cap. */
function rateLimitOk_(email) {
  var cache = CacheService.getScriptCache();
  var keys = [
    { key: 'rl:' + hash_(String(email).toLowerCase()), max: RATE_LIMIT.perEmail, ttl: RATE_LIMIT.windowSeconds },
    { key: 'rl:all', max: RATE_LIMIT.global, ttl: RATE_LIMIT.globalWindowSeconds }
  ];
  for (var i = 0; i < keys.length; i++) {
    var n = Number(cache.get(keys[i].key) || 0);
    if (n >= keys[i].max) return false;
  }
  for (var j = 0; j < keys.length; j++) {
    var m = Number(cache.get(keys[j].key) || 0);
    cache.put(keys[j].key, String(m + 1), keys[j].ttl);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Sheets would run text that starts with = + - @ as a formula; store it as text. */
function escapeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function unescapeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

function rowFor_(s, id, now) {
  var r = { id: id, submittedAt: now, type: s.type };
  for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && k !== 'headshot') r[k] = s[k];
  if (s.type === 'intake') {
    r.availability = s.availability.join(', ');
    r.headshotName = s.headshot ? s.headshot.name : '';
    r.headshotUrl = s.headshotUrl || '';
    r.consent = s.consent ? 'TRUE' : 'FALSE';
  } else if (s.type === 'availability') {
    r.slots = s.slots.join(', ');
  } else {
    r.answers = JSON.stringify(s.answers);
  }
  return SHEETS[s.type].headers.map(function (h) {
    var val = r[h] === undefined || r[h] === null ? '' : r[h];
    return val instanceof Date ? val : escapeCell_(String(val));
  });
}

function spreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheetFor_(type, create) {
  var ss = spreadsheet_();
  var def = SHEETS[type];
  var sheet = ss.getSheetByName(def.name);
  if (!sheet && create) {
    sheet = ss.insertSheet(def.name);
  }
  if (sheet && create && sheet.getLastRow() === 0) {
    sheet.appendRow(def.headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendRow_(type, row) {
  sheetFor_(type, true).appendRow(row);
}

/** All submissions (every type) newer than `since`, oldest first. */
function listSubmissions_(since) {
  var sinceMs = since ? Date.parse(since) : NaN;
  var out = [];
  var types = ['intake', 'availability', 'qa'];
  for (var t = 0; t < types.length; t++) {
    var sheet = sheetFor_(types[t], false);
    if (!sheet || sheet.getLastRow() < 2) continue;
    var values = sheet.getDataRange().getValues();
    var headers = values[0].map(String);
    for (var i = 1; i < values.length; i++) {
      var rec = {};
      for (var c = 0; c < headers.length; c++) {
        var cell = values[i][c];
        rec[headers[c]] = cell instanceof Date ? cell.toISOString() : unescapeCell_(String(cell));
      }
      if (!rec.id) continue;
      rec.type = types[t];
      var at = Date.parse(rec.submittedAt);
      if (!isNaN(sinceMs) && !(at > sinceMs)) continue;
      if (types[t] === 'intake') rec.consent = rec.consent === 'TRUE' || rec.consent === 'true';
      if (types[t] === 'qa') {
        try { rec.answers = JSON.parse(rec.answers || '[]'); } catch (err) { rec.answers = []; }
      }
      out.push(rec);
    }
  }
  out.sort(function (a, b) { return a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0; });
  return out;
}

function headshotFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('HEADSHOT_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* deleted: make a new one */ }
  }
  var folder = DriveApp.createFolder(showName_() + ' guest headshots');
  props.setProperty('HEADSHOT_FOLDER_ID', folder.getId());
  return folder;
}

/** Save the (already resized) photo to Drive. The file stays private to you. */
function saveHeadshot_(h, id, guestName) {
  var bytes = Utilities.base64Decode(h.data);
  if (bytes.length > LIMITS.headshotBytes) throw new Error('Headshot too large');
  var ext = h.type === 'image/png' ? '.png' : h.type === 'image/webp' ? '.webp' : '.jpg';
  var safeName = String(guestName || 'guest').replace(/[^\w .-]/g, '').slice(0, 60) || 'guest';
  var blob = Utilities.newBlob(bytes, h.type, safeName + ' ' + id + ext);
  return headshotFolder_().createFile(blob).getUrl();
}

/** Optional email to NOTIFY_EMAIL (a Script Property), never an address from the request. */
function notify_(s, id) {
  var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (!to || !EMAIL_RE.test(to)) return;
  var what = s.type === 'availability' ? 'availability' : s.type === 'qa' ? 'pre-interview answers' : 'intake form';
  try {
    MailApp.sendEmail({
      to: to,
      subject: showName_() + ': new ' + what + ' from ' + s.name,
      body: s.name + ' (' + s.email + ') sent their ' + what + '.\nSubmission id: ' + id +
        '\n\nOpen the guest manager and press "Check for new submissions" to import it.'
    });
  } catch (err) {
    console.error('Notification failed', err);
  }
}

function showName_() {
  return PropertiesService.getScriptProperties().getProperty('SHOW_NAME') || SHOW_NAME;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(error) {
  return { ok: false, error: error };
}

function newId_() {
  return 's_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function hash_(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  return digest.map(function (b) { return ((b + 256) % 256).toString(16); }).join('').slice(0, 40);
}

function newKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/* ------------------------------------------------------------------ */
/* Run these from the Apps Script editor                               */
/* ------------------------------------------------------------------ */

/**
 * Run once after pasting the code. Creates the sheets and headshot folder,
 * remembers this spreadsheet, and creates READ_KEY if there isn't one.
 * Re-running is safe: nothing existing is replaced.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) props.setProperty('SPREADSHEET_ID', ss.getId());
  props.setProperty('SHOW_NAME', SHOW_NAME);
  sheetFor_('intake', true);
  sheetFor_('availability', true);
  sheetFor_('qa', true);
  headshotFolder_();
  var key = props.getProperty('READ_KEY');
  if (!key || key.length < 16) {
    key = newKey_();
    props.setProperty('READ_KEY', key);
  }
  console.log('Setup done. Your READ_KEY (paste it into Settings -> Intake backend, keep it secret):\n' + key);
  return key;
}

/** Replace READ_KEY. The old key stops working at once; paste the new one in Settings. */
function rotateReadKey() {
  var key = newKey_();
  PropertiesService.getScriptProperties().setProperty('READ_KEY', key);
  console.log('New READ_KEY:\n' + key);
  return key;
}

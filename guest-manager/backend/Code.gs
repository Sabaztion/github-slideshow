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

var RATE_LIMIT = { perEmail: 5, windowSeconds: 600, global: 30, globalWindowSeconds: 60 };

/*
 * Daily caps (reset at midnight UTC). They bound what a
 * bot changing email addresses can do: rows in the sheet, photos in Drive and
 * notification emails (MailApp has its own daily quota).
 */
var DAILY = { submissions: 200, headshots: 100, notifications: 20 };

/** Most rows one list call reads per sheet (the newest ones). */
var LIST_MAX_ROWS = 1000;

var SHEETS = {
  intake: {
    name: 'Submissions',
    headers: ['id', 'submittedAt', 'type', 'name', 'pronouns', 'email', 'social', 'role', 'topic', 'bio',
      'availability', 'timeZone', 'setup', 'notes', 'consent', 'headshotName', 'headshotUrl', 'linkShow', 'token']
  },
  availability: {
    name: 'Availability',
    headers: ['id', 'submittedAt', 'type', 'guestId', 'name', 'email', 'timeZone', 'guestTimeZone', 'slots', 'notes', 'linkShow', 'token', 'slotsUtc']
  },
  qa: {
    name: 'QA',
    headers: ['id', 'submittedAt', 'type', 'guestId', 'name', 'email', 'answers', 'topics', 'linkShow', 'token']
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

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      // Checked inside the lock so parallel requests can't slip past the counters.
      var limited = rateLimitOk_(s.email);
      if (limited !== '') return fail_(limited);
      var id = newId_();
      var now = new Date();
      if (s.type === 'intake' && s.headshot) {
        if (takeDaily_('headshots', DAILY.headshots)) s.headshotUrl = saveHeadshot_(s.headshot, id, s.name);
        else s.headshotSkipped = true; // over today's photo cap: keep the answers, skip the file
      }
      appendRow_(s.type, rowFor_(s, id, now));
      notify_(s, id);
      return s.headshotSkipped ? { ok: true, id: id, note: 'photo-not-saved' } : { ok: true, id: id };
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
var TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
var UTC_SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;
var CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/** Single-line text: like text_, with control characters (newlines, tabs, NUL...) removed. */
function line_(value, max, label, errors) {
  return text_(typeof value === 'string' ? value.replace(CONTROL_RE, ' ') : value, max, label, errors).replace(/\s+/g, ' ');
}

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

/** Exact instants "YYYY-MM-DDTHH:mmZ" (they stay distinct across a DST change). */
function utcSlots_(value, max, errors) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) {
    errors.push('Free times must be a list.');
    return [];
  }
  if (value.length > max) errors.push('Too many free times (' + max + ' at most).');
  var seen = {};
  var out = [];
  for (var i = 0; i < value.length && out.length < max; i++) {
    var s = String(value[i]);
    if (!UTC_SLOT_RE.test(s) || isNaN(Date.parse(s))) {
      errors.push('Free times contain an invalid time.');
      break;
    }
    if (!seen[s]) { seen[s] = true; out.push(s); }
  }
  return out.sort();
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
  v.name = line_(body.name, LIMITS.name, 'Name', errors);
  v.email = line_(body.email, LIMITS.email, 'Email', errors);
  v.linkShow = line_(body.show, LIMITS.show, 'Show', errors);
  var token = line_(body.token, 64, 'Token', errors);
  v.token = TOKEN_RE.test(token) ? token : '';
  if (!v.name) errors.push('Name is required.');
  if (!v.email) errors.push('Email is required.');
  else if (!EMAIL_RE.test(v.email)) errors.push('Email is not valid.');
  var tz = line_(body.timeZone, LIMITS.timeZone, 'Time zone', errors);
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
    var gtz = line_(body.guestTimeZone, LIMITS.timeZone, 'Guest time zone', errors);
    v.guestTimeZone = TZ_RE.test(gtz) ? gtz : '';
    v.slots = slots_(body.slots, LIMITS.slots, 'free times', errors);
    v.slotsUtc = utcSlots_(body.slotsUtc, LIMITS.slots, errors);
    v.notes = text_(body.notes, LIMITS.notes, 'Notes', errors);
    if (!v.slots.length && !v.slotsUtc.length) errors.push('Pick at least one free time.');
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
  if (imageKind_(data) !== type) return { ok: false, error: 'The photo’s contents don’t match its type.' };
  var name = String(h.name || 'headshot').replace(/[^\w .-]/g, '').slice(0, LIMITS.headshotName) || 'headshot';
  return { ok: true, value: { name: name, type: type, data: data } };
}

/** Image type from the file's first bytes (magic numbers), or ''. */
function imageKind_(base64) {
  var head;
  try {
    head = Utilities.base64Decode(base64.slice(0, 16)).map(function (b) { return (b + 256) % 256; });
  } catch (err) {
    return '';
  }
  var at = function (i) { return head[i]; };
  if (at(0) === 0xFF && at(1) === 0xD8 && at(2) === 0xFF) return 'image/jpeg';
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4E && at(3) === 0x47) return 'image/png';
  var riff = String.fromCharCode(at(0), at(1), at(2), at(3));
  var webp = String.fromCharCode(at(8), at(9), at(10), at(11));
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  return '';
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

/**
 * Rate limits: per email (10 minutes), all submissions (per minute), and a
 * daily cap. Returns '' when allowed, else a message. Call inside the lock.
 */
function rateLimitOk_(email) {
  var cache = CacheService.getScriptCache();
  var keys = [
    { key: 'rl:' + hash_(String(email).toLowerCase()), max: RATE_LIMIT.perEmail, ttl: RATE_LIMIT.windowSeconds },
    { key: 'rl:all', max: RATE_LIMIT.global, ttl: RATE_LIMIT.globalWindowSeconds }
  ];
  for (var i = 0; i < keys.length; i++) {
    var n = Number(cache.get(keys[i].key) || 0);
    if (n >= keys[i].max) return 'Too many submissions in a short time. Please wait a few minutes and try again.';
  }
  if (!takeDaily_('submissions', DAILY.submissions)) return 'The show has received too many submissions today. Please try again tomorrow or email the show.';
  for (var j = 0; j < keys.length; j++) {
    var m = Number(cache.get(keys[j].key) || 0);
    cache.put(keys[j].key, String(m + 1), keys[j].ttl);
  }
  return '';
}

/** Today's date (UTC), "yyyy-MM-dd". Daily caps reset at midnight UTC. */
function today_() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Count one use of a daily allowance stored in Script Properties. Returns
 * false (and counts nothing) when today's cap is reached. Older days' counters
 * are removed as a new day starts.
 */
function takeDaily_(name, cap) {
  var props = PropertiesService.getScriptProperties();
  var key = 'daily:' + today_() + ':' + name;
  var n = Number(props.getProperty(key) || 0);
  if (n >= cap) return false;
  if (n === 0) {
    var all = props.getProperties ? props.getProperties() : {};
    for (var k in all) {
      if (k.indexOf('daily:') === 0 && k.indexOf('daily:' + today_() + ':') !== 0) props.deleteProperty(k);
    }
  }
  props.setProperty(key, String(n + 1));
  return true;
}

function dailyCount_(name) {
  return Number(PropertiesService.getScriptProperties().getProperty('daily:' + today_() + ':' + name) || 0);
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

/** A record for the sheet: field name -> value (a Date for submittedAt). */
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
    r.slotsUtc = s.slotsUtc.join(', ');
  } else {
    r.answers = JSON.stringify(s.answers);
  }
  return r;
}

function spreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * The sheet for a submission type. With `create`, it is created if missing,
 * its header row gets any columns added in newer versions of this script, and
 * every column except submittedAt is formatted as plain text.
 */
function sheetFor_(type, create, reformat) {
  var ss = spreadsheet_();
  var def = SHEETS[type];
  var sheet = ss.getSheetByName(def.name);
  if (!sheet && create) sheet = ss.insertSheet(def.name);
  if (sheet && create) ensureHeaders_(sheet, def.headers, reformat);
  return sheet;
}

function headersOf_(sheet) {
  var cols = sheet.getLastColumn();
  if (!cols || sheet.getLastRow() === 0) return [];
  return sheet.getRange(1, 1, 1, cols).getValues()[0].map(String);
}

function ensureHeaders_(sheet, wanted, reformat) {
  var have = headersOf_(sheet);
  var missing = wanted.filter(function (h) { return have.indexOf(h) < 0; });
  if (missing.length) {
    sheet.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
    have = have.concat(missing);
    sheet.setFrozenRows(1);
  }
  if (!missing.length && !reformat) return have;
  // Plain text, so Sheets never turns "3/4", "TRUE", "0012" or a slot time into a date or number.
  var rows = Math.max(sheet.getMaxRows(), 2);
  for (var c = 0; c < have.length; c++) {
    sheet.getRange(1, c + 1, rows, 1).setNumberFormat(have[c] === 'submittedAt' ? 'yyyy-mm-dd hh:mm:ss' : '@');
  }
  return have;
}

/** Write one record under the sheet's own header order, as text (setValues, not appendRow). */
function appendRow_(type, record) {
  var sheet = sheetFor_(type, true);
  var headers = headersOf_(sheet);
  var row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);
  var values = headers.map(function (h) {
    var v = record[h] === undefined || record[h] === null ? '' : record[h];
    return v instanceof Date ? v : escapeCell_(String(v));
  });
  var formats = headers.map(function (h) { return h === 'submittedAt' ? 'yyyy-mm-dd hh:mm:ss' : '@'; });
  var range = sheet.getRange(row, 1, 1, headers.length);
  range.setNumberFormats([formats]);
  range.setValues([values]);
}

/**
 * First data row (2-based) whose submittedAt is after `sinceMs`. Rows are
 * written in time order, so this reads only the submittedAt column, in chunks
 * from the end, and stops at the first older row.
 */
function firstRowAfter_(sheet, tsCol, sinceMs, lastRow) {
  var first = lastRow + 1;
  var chunk = 200;
  for (var end = lastRow; end >= 2; end -= chunk) {
    var start = Math.max(2, end - chunk + 1);
    var vals = sheet.getRange(start, tsCol, end - start + 1, 1).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      var v = vals[i][0];
      var ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
      if (!(ms > sinceMs)) return first;
      first = start + i;
    }
  }
  return first;
}

/**
 * Submissions (every type) newer than `since`, oldest first. Only the rows
 * after `since` are read, and at most LIST_MAX_ROWS per sheet.
 */
function listSubmissions_(since) {
  var sinceMs = since ? Date.parse(since) : NaN;
  var out = [];
  var types = ['intake', 'availability', 'qa'];
  for (var t = 0; t < types.length; t++) {
    var sheet = sheetFor_(types[t], false);
    if (!sheet) continue;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;
    var headers = headersOf_(sheet);
    var tsCol = headers.indexOf('submittedAt') + 1;
    var first = !isNaN(sinceMs) && tsCol > 0 ? firstRowAfter_(sheet, tsCol, sinceMs, lastRow) : 2;
    first = Math.max(first, lastRow - LIST_MAX_ROWS + 1, 2);
    if (first > lastRow) continue;
    var values = sheet.getRange(first, 1, lastRow - first + 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var rec = {};
      for (var c = 0; c < headers.length; c++) {
        var cell = values[i][c];
        rec[headers[c]] = cell instanceof Date ? cell.toISOString() : unescapeCell_(String(cell));
      }
      if (!rec.id) continue;
      rec.type = types[t];
      if (!isNaN(sinceMs) && !(Date.parse(rec.submittedAt) > sinceMs)) continue;
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

/**
 * Optional email to NOTIFY_EMAIL (a Script Property), never an address from
 * the request. At most DAILY.notifications a day; the last one says so.
 */
function notify_(s, id) {
  var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (!to || !EMAIL_RE.test(to)) return;
  if (!takeDaily_('notifications', DAILY.notifications)) return;
  var last = dailyCount_('notifications') === DAILY.notifications;
  var what = s.type === 'availability' ? 'availability' : s.type === 'qa' ? 'pre-interview answers' : 'intake form';
  var who = String(s.name).replace(CONTROL_RE, ' ').slice(0, 80);
  try {
    MailApp.sendEmail({
      to: to,
      subject: (showName_() + ': new ' + what + ' from ' + who).replace(CONTROL_RE, ' '),
      body: who + ' (' + s.email + ') sent their ' + what + '.\nSubmission id: ' + id +
        '\n\nOpen the guest manager and press "Check for new submissions" to import it.' +
        (last ? '\n\nThis is the last notification today (limit ' + DAILY.notifications + '). Further submissions are still saved; check the sheet or the app.' : '')
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
  sheetFor_('intake', true, true);
  sheetFor_('availability', true, true);
  sheetFor_('qa', true, true);
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

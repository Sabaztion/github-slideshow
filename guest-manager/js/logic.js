// Pure logic for the podcast guest manager.
// No DOM, no storage access: everything here is deterministic and unit-tested
// with `node --test guest-manager/tests/`.

export const APP_ID = 'podcast-guest-manager';
export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'podcast-guest-manager:v1';

/* ------------------------------------------------------------------ */
/* Stages                                                              */
/* ------------------------------------------------------------------ */

export const STAGES = Object.freeze([
  { id: 'outreach', label: 'Outreach', dot: '#8C8576', bg: '#E9E4D8', fg: '#4A463E' },
  { id: 'booked', label: 'Booked', dot: '#1F5F8B', bg: '#DCE8F2', fg: '#1B4F75' },
  { id: 'recorded', label: 'Recorded', dot: '#C0651E', bg: '#F6E1CF', fg: '#8A3F0C' },
  { id: 'editing', label: 'Editing', dot: '#6B3F8C', bg: '#ECE2F1', fg: '#56306F' },
  { id: 'published', label: 'Published', dot: '#2D5A2F', bg: '#DDEBDD', fg: '#2D5A2F' }
]);

export const STAGE_IDS = STAGES.map((s) => s.id);

export function isValidStage(id) {
  return STAGE_IDS.includes(id);
}

export function stageIndex(id) {
  return STAGE_IDS.indexOf(id);
}

export function getStage(id) {
  return STAGES.find((s) => s.id === id) || null;
}

/** The stage after `id`, or null when `id` is the last stage (or unknown). */
export function nextStage(id) {
  const i = stageIndex(id);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

/** The stage before `id`, or null when `id` is the first stage (or unknown). */
export function prevStage(id) {
  const i = stageIndex(id);
  return i > 0 ? STAGES[i - 1] : null;
}

/**
 * Return a copy of `guest` moved to `toStage`. Any stage can be reached
 * directly (drag and drop allows skipping and going back). Moving to the
 * current stage returns the same object untouched.
 */
export function moveGuest(guest, toStage, nowIso = new Date().toISOString()) {
  if (!isValidStage(toStage)) throw new Error(`Unknown stage: ${toStage}`);
  if (guest.stage === toStage) return guest;
  return { ...guest, stage: toStage, stageChangedAt: nowIso, updatedAt: nowIso };
}

/** Move a guest one stage forward. Guests in the last stage are returned unchanged. */
export function advanceGuest(guest, nowIso) {
  const next = nextStage(guest.stage);
  return next ? moveGuest(guest, next.id, nowIso) : guest;
}

export function countByStage(guests) {
  const counts = Object.fromEntries(STAGE_IDS.map((id) => [id, 0]));
  for (const g of guests) if (g.stage in counts) counts[g.stage] += 1;
  return counts;
}

/* ------------------------------------------------------------------ */
/* Prep checklist                                                      */
/* ------------------------------------------------------------------ */

export const CHECKS = Object.freeze([
  { key: 'call', label: 'Pre-interview call' },
  { key: 'bio', label: 'Bio & headshot received' },
  { key: 'kit', label: 'Mic & recording guide sent' },
  { key: 'release', label: 'Release form signed' },
  { key: 'promo', label: 'Promo assets sent' }
]);

export function prepProgress(guest) {
  const checks = (guest && guest.checks) || {};
  const done = CHECKS.filter((c) => checks[c.key] === true).length;
  const total = CHECKS.length;
  return { done, total, pct: Math.round((done / total) * 100), complete: done === total };
}

export function toggleCheck(guest, key, nowIso = new Date().toISOString()) {
  if (!CHECKS.some((c) => c.key === key)) throw new Error(`Unknown checklist item: ${key}`);
  const checks = { ...guest.checks, [key]: !guest.checks?.[key] };
  return { ...guest, checks, updatedAt: nowIso };
}

/* ------------------------------------------------------------------ */
/* Guests                                                              */
/* ------------------------------------------------------------------ */

export const GUEST_TEXT_FIELDS = Object.freeze([
  'name', 'pronouns', 'role', 'topic', 'email', 'social', 'recordingAt',
  'episode', 'episodeLink', 'bio', 'notes', 'setup', 'headshot', 'source'
]);

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = [...parts[0]][0] || '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] || '' : '';
  return (first + last).toUpperCase();
}

export function displayName(guest) {
  const n = String(guest?.name || '').trim();
  return n || 'Untitled guest';
}

export function defaultId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'g_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return 'g_' + Math.random().toString(36).slice(2, 14);
}

/** Build a complete guest record from partial input. */
export function createGuest(partial = {}, { idFn = defaultId, nowIso = new Date().toISOString() } = {}) {
  return normalizeGuest({ ...partial, id: partial.id || idFn(), createdAt: nowIso, updatedAt: nowIso, stageChangedAt: nowIso }, { idFn });
}

/** Coerce any object into a well-formed guest record (used on load/import). */
export function normalizeGuest(raw, { idFn = defaultId } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const g = {};
  g.id = typeof src.id === 'string' && src.id ? src.id : idFn();
  for (const f of GUEST_TEXT_FIELDS) g[f] = src[f] == null ? '' : String(src[f]);
  if (g.recordingAt && !parseLocal(g.recordingAt)) g.recordingAt = '';
  if (g.recordingAt) g.recordingAt = toLocalString(parseLocal(g.recordingAt));
  g.stage = isValidStage(src.stage) ? src.stage : 'outreach';
  const checks = src.checks && typeof src.checks === 'object' ? src.checks : {};
  g.checks = Object.fromEntries(CHECKS.map((c) => [c.key, checks[c.key] === true]));
  g.availability = Array.isArray(src.availability)
    ? [...new Set(src.availability.map(String).filter((s) => parseLocal(s)).map((s) => toLocalString(parseLocal(s))))].sort()
    : [];
  g.sample = src.sample === true;
  const now = new Date().toISOString();
  g.createdAt = typeof src.createdAt === 'string' ? src.createdAt : now;
  g.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : g.createdAt;
  g.stageChangedAt = typeof src.stageChangedAt === 'string' ? src.stageChangedAt : g.createdAt;
  return g;
}

export function updateGuestField(guest, field, value, nowIso = new Date().toISOString()) {
  if (!GUEST_TEXT_FIELDS.includes(field)) throw new Error(`Unknown field: ${field}`);
  return { ...guest, [field]: value == null ? '' : String(value), updatedAt: nowIso };
}

/** Case-insensitive search across name, topic and role. Every word must match. */
export function filterGuests(guests, query) {
  const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return guests.slice();
  return guests.filter((g) => {
    const hay = `${g.name} ${g.topic} ${g.role}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export const SORT_KEYS = Object.freeze(['name', 'stage', 'recording']);

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { sensitivity: 'base', numeric: true }) : null;
function compareText(a, b) {
  return collator ? collator.compare(a, b) : String(a).localeCompare(String(b));
}

/**
 * Sort guests by 'name', 'stage' (pipeline order) or 'recording' (date).
 * Guests without a recording date always sort last. Ties break by name.
 */
export function sortGuests(guests, key = 'name', dir = 'asc') {
  if (!SORT_KEYS.includes(key)) throw new Error(`Unknown sort key: ${key}`);
  const sign = dir === 'desc' ? -1 : 1;
  const byName = (a, b) => compareText(displayName(a), displayName(b));
  return guests.slice().sort((a, b) => {
    let r = 0;
    if (key === 'name') r = byName(a, b) * sign;
    else if (key === 'stage') r = (stageIndex(a.stage) - stageIndex(b.stage)) * sign;
    else {
      const ha = !!a.recordingAt, hb = !!b.recordingAt;
      if (ha !== hb) return ha ? -1 : 1;
      if (ha) r = (a.recordingAt < b.recordingAt ? -1 : a.recordingAt > b.recordingAt ? 1 : 0) * sign;
    }
    return r || byName(a, b);
  });
}

/* ------------------------------------------------------------------ */
/* Dates. Recording times are stored as naive local strings           */
/* ("YYYY-MM-DDTHH:mm") meaning wall-clock time in the host time zone. */
/* ------------------------------------------------------------------ */

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => String(n).padStart(2, '0');

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Parse "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" into parts, or null if invalid. */
export function parseLocal(str) {
  const m = DT_RE.exec(String(str || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hh = m[4] == null ? 0 : Number(m[4]);
  const mm = m[5] == null ? 0 : Number(m[5]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || hh > 23 || mm > 59) return null;
  return { y, m: mo, d, hh, mm, hasTime: m[4] != null };
}

export function toLocalString(p) {
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
}

export function dayKey(str) {
  const p = parseLocal(str);
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : '';
}

export function weekday(p) {
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

export function formatTime(str) {
  const p = parseLocal(str);
  if (!p) return '';
  const h12 = p.hh % 12 === 0 ? 12 : p.hh % 12;
  return `${h12}:${pad(p.mm)} ${p.hh < 12 ? 'AM' : 'PM'}`;
}

/** "Mon, Oct 5" */
export function formatDay(str) {
  const p = parseLocal(str);
  if (!p) return '';
  return `${DAYS[weekday(p)]}, ${MONTHS[p.m - 1]} ${p.d}`;
}

/** "Tue Oct 6 · 2:00 PM" (matches the pipeline mockup). */
export function formatRecording(str) {
  const p = parseLocal(str);
  if (!p) return '';
  return `${DAYS[weekday(p)]} ${MONTHS[p.m - 1]} ${p.d} · ${formatTime(str)}`;
}

/** "Sep 24" */
export function formatShortDate(str) {
  const p = parseLocal(str);
  return p ? `${MONTHS[p.m - 1]} ${p.d}` : '';
}

export function monthLabel(year, month) {
  return `${MONTHS_LONG[month - 1]} ${year}`;
}

/** Current wall-clock time in `timeZone` as "YYYY-MM-DDTHH:mm". */
export function nowInZone(timeZone, date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
  } catch {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Add `n` days to "YYYY-MM-DD" (or a datetime; the time part is kept). */
export function addDays(str, n) {
  const p = parseLocal(str);
  if (!p) throw new Error(`Invalid date: ${str}`);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return p.hasTime ? `${ymd}T${pad(p.hh)}:${pad(p.mm)}` : ymd;
}

export function shiftMonth(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12 + 12) % 12 + 1 };
}

/**
 * Group guests with a valid recording time by day.
 * Returns { "YYYY-MM-DD": [guest, ...] } with each day sorted by time.
 */
export function groupByDay(guests) {
  const out = {};
  for (const g of guests) {
    const key = dayKey(g.recordingAt);
    if (!key) continue;
    (out[key] ||= []).push(g);
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => (a.recordingAt < b.recordingAt ? -1 : a.recordingAt > b.recordingAt ? 1 : compareText(displayName(a), displayName(b))));
  }
  return out;
}

/**
 * Weeks for a month view. Each week is 7 cells { ymd, day, inMonth }.
 * Always starts on `weekStartsOn` (0 = Sunday) and ends on a full week.
 */
export function monthGrid(year, month, weekStartsOn = 0) {
  const first = `${year}-${pad(month)}-01`;
  const lead = (weekday(parseLocal(first)) - weekStartsOn + 7) % 7;
  const total = daysInMonth(year, month);
  const cellCount = Math.ceil((lead + total) / 7) * 7;
  const start = addDays(first, -lead);
  const weeks = [];
  for (let i = 0; i < cellCount; i++) {
    const ymd = addDays(start, i);
    const p = parseLocal(ymd);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ ymd, day: p.d, inMonth: p.m === month && p.y === year });
  }
  return weeks;
}

/**
 * Suggested intake slots: the next Monday, Wednesday and Friday after
 * `todayYmd`, at 10:00 and 14:00.
 */
export function suggestSlots(todayYmd, times = ['10:00', '14:00']) {
  const wanted = [1, 3, 5];
  const slots = [];
  let cursor = dayKey(todayYmd);
  for (let i = 1; i <= 14 && slots.length < wanted.length * times.length; i++) {
    const ymd = addDays(cursor, i);
    if (wanted.includes(weekday(parseLocal(ymd)))) for (const t of times) slots.push(`${ymd}T${t}`);
  }
  return slots;
}

/* ------------------------------------------------------------------ */
/* Email templates                                                     */
/* ------------------------------------------------------------------ */

export const PLACEHOLDERS = Object.freeze(['guest_name', 'recording_time', 'show_name', 'episode_link']);

export const DEFAULT_TEMPLATES = Object.freeze([
  {
    id: 'invitation',
    name: 'Invitation',
    subject: 'Would you come on {{show_name}}?',
    body: 'Hi {{guest_name}},\n\nI host {{show_name}}, and I would love to have you on as a guest. I think our listeners would get a lot out of a conversation with you.\n\nRecording takes about an hour, remotely or in our studio, and I will send everything you need ahead of time.\n\nWould you be up for it? If so, just reply and I will share a few times.\n\nThanks,\nThe {{show_name}} team'
  },
  {
    id: 'booking',
    name: 'Booking confirmation',
    subject: "You're booked on {{show_name}}: {{recording_time}}",
    body: "Hi {{guest_name}},\n\nThanks for saying yes! You're confirmed for {{recording_time}}.\n\nBefore then I'll set up a short pre-interview call and send our mic and recording guide. If you can, please reply with a short bio and a square headshot.\n\nSee you soon,\nThe {{show_name}} team"
  },
  {
    id: 'reminder',
    name: 'Recording reminder',
    subject: 'Reminder: {{show_name}} recording, {{recording_time}}',
    body: "Hi {{guest_name}},\n\nA quick reminder that we're recording {{show_name}} on {{recording_time}}.\n\nA few tips: wear headphones, find a quiet room with soft furnishings, and close any apps that might make noise. Join a few minutes early so we can check levels.\n\nLooking forward to it,\nThe {{show_name}} team"
  },
  {
    id: 'thanks',
    name: 'Thank-you + episode link',
    subject: 'Your {{show_name}} episode is live',
    body: 'Hi {{guest_name}},\n\nThank you again for coming on {{show_name}}. Your episode is out now:\n\n{{episode_link}}\n\nWe would be grateful if you shared it with your audience. Promo clips and artwork are on the way.\n\nWith thanks,\nThe {{show_name}} team'
  }
]);

/** Replace {{placeholder}} tokens. Unknown placeholders are left as-is. */
export function renderTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : match
  );
}

export function templateVars(guest, settings) {
  const tz = settings?.timeZone || '';
  const when = guest?.recordingAt ? formatRecording(guest.recordingAt) : '';
  return {
    guest_name: String(guest?.name || '').trim() || 'there',
    recording_time: when ? (tz ? `${when} (${tz})` : when) : 'a time to be confirmed',
    show_name: String(settings?.showName || '').trim() || 'our show',
    episode_link: String(guest?.episodeLink || '').trim() || '[episode link to come]'
  };
}

export function renderEmail(template, guest, settings) {
  const vars = templateVars(guest, settings);
  return { subject: renderTemplate(template.subject, vars), body: renderTemplate(template.body, vars) };
}

/** RFC 6068 mailto: link. Line breaks become CRLF. */
export function buildMailto(to, subject = '', body = '') {
  const enc = (s) => encodeURIComponent(String(s));
  const addr = encodeURIComponent(String(to || '').trim()).replace(/%40/g, '@');
  const params = [];
  if (subject) params.push('subject=' + enc(subject));
  if (body) params.push('body=' + enc(String(body).replace(/\r?\n/g, '\r\n')));
  return `mailto:${addr}${params.length ? '?' + params.join('&') : ''}`;
}

export function normalizeTemplates(list) {
  const byId = new Map(Array.isArray(list) ? list.filter((t) => t && typeof t === 'object').map((t) => [t.id, t]) : []);
  return DEFAULT_TEMPLATES.map((def) => {
    const t = byId.get(def.id) || {};
    return {
      id: def.id,
      name: def.name,
      subject: typeof t.subject === 'string' ? t.subject : def.subject,
      body: typeof t.body === 'string' ? t.body : def.body
    };
  });
}

/* ------------------------------------------------------------------ */
/* Settings + whole-app state                                          */
/* ------------------------------------------------------------------ */

export function defaultSettings(timeZone = 'UTC') {
  return { showName: 'My Podcast', timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC', hostEmail: '', intakeSlots: [] };
}

export function normalizeSettings(raw, fallbackTz = 'UTC') {
  const base = defaultSettings(fallbackTz);
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    showName: typeof s.showName === 'string' && s.showName.trim() ? s.showName : base.showName,
    timeZone: isValidTimeZone(s.timeZone) ? s.timeZone : base.timeZone,
    hostEmail: typeof s.hostEmail === 'string' ? s.hostEmail : '',
    intakeSlots: Array.isArray(s.intakeSlots)
      ? [...new Set(s.intakeSlots.map(String).filter((x) => parseLocal(x)?.hasTime).map((x) => toLocalString(parseLocal(x))))].sort()
      : []
  };
}

export function createInitialState({ timeZone = 'UTC', today, idFn = defaultId, withSamples = true } = {}) {
  const settings = defaultSettings(timeZone);
  const day = today || nowInZone(settings.timeZone).slice(0, 10);
  return {
    version: SCHEMA_VERSION,
    settings,
    guests: withSamples ? sampleGuests(day) : [],
    templates: normalizeTemplates([])
  };
}

export function serializeState(state, exportedAt) {
  const out = {
    app: APP_ID,
    version: SCHEMA_VERSION,
    settings: state.settings,
    guests: state.guests,
    templates: state.templates
  };
  if (exportedAt) out.exportedAt = exportedAt;
  return JSON.stringify(out, null, 2);
}

/** Parse and validate stored or imported JSON. Throws a readable Error. */
export function parseState(json, { idFn = defaultId, timeZone = 'UTC' } = {}) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a guest manager backup object.');
  if (data.app && data.app !== APP_ID) throw new Error('This backup is from a different app.');
  if (typeof data.version === 'number' && data.version > SCHEMA_VERSION) throw new Error('This backup is from a newer version of the app.');
  if (!Array.isArray(data.guests)) throw new Error('The backup has no guest list.');
  const seen = new Set();
  const guests = data.guests.map((g) => {
    const n = normalizeGuest(g, { idFn });
    if (seen.has(n.id)) n.id = idFn();
    seen.add(n.id);
    return n;
  });
  return {
    version: SCHEMA_VERSION,
    settings: normalizeSettings(data.settings, timeZone),
    guests,
    templates: normalizeTemplates(data.templates)
  };
}

export function upsertGuest(state, guest) {
  const exists = state.guests.some((g) => g.id === guest.id);
  return { ...state, guests: exists ? state.guests.map((g) => (g.id === guest.id ? guest : g)) : [...state.guests, guest] };
}

export function removeGuest(state, id) {
  return { ...state, guests: state.guests.filter((g) => g.id !== id) };
}

export function clearSamples(state) {
  return { ...state, guests: state.guests.filter((g) => !g.sample) };
}

export function hasSamples(state) {
  return state.guests.some((g) => g.sample);
}

/* ------------------------------------------------------------------ */
/* Sample data (relative to today so the calendar has something to show) */
/* ------------------------------------------------------------------ */

export function sampleGuests(todayYmd) {
  const at = (offset, time) => `${addDays(dayKey(todayYmd), offset)}T${time}`;
  const all = (...keys) => Object.fromEntries(keys.map((k) => [k, true]));
  const rows = [
    { id: 'sample-maya', name: 'Maya Okafor', pronouns: 'she/her', role: 'Urban ecologist', topic: 'Rewilding city rooftops', stage: 'outreach', email: 'maya@example.com', social: '@mayaokafor', notes: 'Intro via listener email. Follow up if no reply within a week.', checks: {} },
    { id: 'sample-dev', name: 'Dev Raman', pronouns: 'he/him', role: 'Indie game designer', topic: 'Designing games about grief', stage: 'outreach', email: 'dev@example.com', social: '@devmakesgames', notes: 'Saw his conference talk. Ask about the solo-dev workflow.', checks: {} },
    { id: 'sample-lena', name: 'Lena Brandt', pronouns: 'she/her', role: 'Author, "Quiet Hours"', topic: 'Why boredom makes us creative', stage: 'booked', recordingAt: at(8, '14:00'), email: 'lena@example.com', social: '@lenabrandt', notes: 'Publicist is CC’d on everything. Aim to publish the week before the book comes out.', checks: all('call', 'bio') },
    { id: 'sample-tomas', name: 'Tomás Ibarra', pronouns: 'he/him', role: 'Chef & restaurateur', topic: 'Running a zero-waste kitchen', stage: 'booked', recordingAt: at(10, '11:00'), email: 'tomas@example.com', social: '@chefibarra', notes: 'Recording in person at the studio. Needs parking info.', checks: all('call') },
    { id: 'sample-priya', name: 'Priya Shah', pronouns: 'she/her', role: 'Sleep researcher', topic: 'What your 3 a.m. wake-ups mean', stage: 'recorded', recordingAt: at(-4, '10:00'), email: 'priya@example.com', social: '@drpriyashah', notes: 'Great tape. Send edit for fact-check before release.', checks: all('call', 'bio', 'kit', 'release') },
    { id: 'sample-jonah', name: 'Jonah Weiss', pronouns: 'he/him', role: 'Documentary producer', topic: 'Making films on a phone', stage: 'recorded', recordingAt: at(-10, '15:00'), email: 'jonah@example.com', social: '@jonahweiss', notes: 'Release form still outstanding. Nudge before editing.', checks: all('call', 'bio', 'kit') },
    { id: 'sample-noor', name: 'Noor Haddad', pronouns: 'she/her', role: 'Climate reporter', topic: 'Reporting on heat without doom', stage: 'editing', recordingAt: at(-15, '13:00'), episode: '42', email: 'noor@example.com', social: 'https://example.com/noor', notes: 'Cut the tangent about trains; keep the heat-map story.', checks: all('call', 'bio', 'kit', 'release') },
    { id: 'sample-aiko', name: 'Aiko Mori', pronouns: 'she/they', role: 'Ceramicist', topic: 'Kintsugi and repairing things', stage: 'published', recordingAt: at(-24, '10:00'), episode: '41', episodeLink: 'https://example.com/episodes/41', email: 'aiko@example.com', social: '@aikomori.studio', notes: 'Send clip pack and episode link for her newsletter.', checks: all('call', 'bio', 'kit', 'release') }
  ];
  const nowIso = `${dayKey(todayYmd)}T00:00:00.000Z`;
  return rows.map((r) => normalizeGuest({ ...r, sample: true, createdAt: nowIso }));
}

/* ------------------------------------------------------------------ */
/* Intake form                                                         */
/* ------------------------------------------------------------------ */

export const SETUP_OPTIONS = Object.freeze([
  { id: 'studio', label: 'In our studio' },
  { id: 'remote-own', label: 'Remote, own mic' },
  { id: 'remote-kit', label: 'Remote, need a kit' }
]);

export function setupLabel(id) {
  return SETUP_OPTIONS.find((o) => o.id === id)?.label || '';
}

/** Validate intake answers. Returns a map of field -> message (empty when valid). */
export function validateIntake(a) {
  const errors = {};
  if (!String(a.name || '').trim()) errors.name = 'Please enter your name.';
  const email = String(a.email || '').trim();
  if (!email) errors.email = 'Please enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Please enter a valid email address, like name@example.com.';
  return errors;
}

/** Turn intake answers into a guest record (stage: Outreach). */
export function intakeToGuest(a, { idFn = defaultId, nowIso = new Date().toISOString(), id } = {}) {
  const notes = String(a.notes || '').trim();
  const setup = setupLabel(a.setup);
  const noteLines = ['Submitted via intake form.'];
  if (setup) noteLines.push(`Recording setup: ${setup}.`);
  if (a.headshot) noteLines.push(`Headshot file: ${a.headshot} (ask the guest to email it).`);
  if (notes) noteLines.push('', notes);
  return createGuest({
    id,
    name: String(a.name || '').trim(),
    pronouns: String(a.pronouns || '').trim(),
    role: String(a.role || '').trim(),
    topic: String(a.topic || '').trim(),
    email: String(a.email || '').trim(),
    social: String(a.social || '').trim(),
    bio: String(a.bio || '').trim(),
    setup: a.setup || '',
    headshot: a.headshot || '',
    availability: Array.isArray(a.availability) ? a.availability : [],
    notes: noteLines.join('\n'),
    stage: 'outreach',
    source: 'intake',
    checks: { bio: !!(String(a.bio || '').trim() && a.headshot), release: a.consent === true }
  }, { idFn, nowIso });
}

/** Plain-text version of the intake answers, for a guest to email. */
export function intakeToText(a, settings) {
  const tz = settings?.timeZone || '';
  const lines = [
    `Guest intake for ${String(settings?.showName || '').trim() || 'the show'}`,
    '',
    `Name: ${a.name || ''}`,
    `Pronouns: ${a.pronouns || '-'}`,
    `Role / title: ${a.role || '-'}`,
    `Proposed topic: ${a.topic || '-'}`,
    `Email: ${a.email || ''}`,
    `Website or social: ${a.social || '-'}`,
    '',
    'Short bio:',
    a.bio ? String(a.bio) : '-',
    '',
    `Headshot: ${a.headshot ? `${a.headshot} (attached separately)` : 'not provided'}`,
    '',
    `Times that work${tz ? ` (${tz})` : ''}:`
  ];
  const slots = (a.availability || []).filter((s) => parseLocal(s));
  if (slots.length) for (const s of slots.slice().sort()) lines.push(`- ${formatDay(s)}, ${formatTime(s)}`);
  else lines.push('- none picked');
  lines.push('', `Recording setup: ${setupLabel(a.setup) || '-'}`, '', 'Anything we should know:', a.notes ? String(a.notes) : '-', '', `Agrees to publication and promo clips: ${a.consent ? 'Yes' : 'No'}`);
  return lines.join('\n');
}

/** Shareable intake link that carries the host's settings in the query string. */
export function buildIntakeUrl(base, settings) {
  const params = new URLSearchParams();
  if (settings.showName) params.set('show', settings.showName);
  if (settings.timeZone) params.set('tz', settings.timeZone);
  if (settings.hostEmail) params.set('to', settings.hostEmail);
  if (settings.intakeSlots?.length) params.set('slots', settings.intakeSlots.join(','));
  const q = params.toString();
  return q ? `${base}?${q}` : base;
}

/** Read overrides from an intake URL query string. Invalid values are dropped. */
export function readIntakeParams(search) {
  const p = new URLSearchParams(search || '');
  const out = {};
  const show = p.get('show');
  if (show && show.trim()) out.showName = show.trim().slice(0, 120);
  const tz = p.get('tz');
  if (tz && isValidTimeZone(tz)) out.timeZone = tz;
  const to = p.get('to');
  if (to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) out.hostEmail = to;
  const slots = p.get('slots');
  if (slots) {
    const list = slots.split(',').map((s) => s.trim()).filter((s) => parseLocal(s)?.hasTime).map((s) => toLocalString(parseLocal(s)));
    if (list.length) out.intakeSlots = [...new Set(list)].sort();
  }
  return out;
}

// Pure logic for the Google Apps Script backend (backend/Code.gs): building
// and validating what guest pages send, reading what the list endpoint
// returns, and importing submissions into the guest list (dedupe by
// submission id, merge by guest id or email). No DOM, storage or network.
import {
  createGuest, normalizeGuest, parseLocal, toLocalString, setupLabel, safeHttpUrl, isValidTimeZone, normalizeEndpoint,
  newGuestToken, TOKEN_RE
} from './logic.js';
import { convertSlot, utcToLocal, MAX_FREE_SLOTS } from './slots.js';
import { mergeQaAnswers, QA_LIMITS } from './plan.js';

/** Same limits as backend/Code.gs (LIMITS). Keep the two in sync. */
export const LIMITS = Object.freeze({
  name: 120, pronouns: 60, email: 254, social: 300, role: 160, topic: 300, bio: 2000, notes: 2000,
  setup: 40, timeZone: 64, show: 120, guestId: 64, headshotName: 200, availability: 30,
  slots: MAX_FREE_SLOTS, answers: QA_LIMITS.questions, question: QA_LIMITS.question, answer: QA_LIMITS.answer,
  topics: QA_LIMITS.topics, headshotBytes: 1.5 * 1024 * 1024
});

/** Name of the hidden spam-trap field. People never see or fill it; many bots do. */
export const HONEYPOT_FIELD = 'hp_website';

export const SUBMISSION_TYPES = Object.freeze(['intake', 'availability', 'qa']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const UTC_SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00(\.000)?)?Z$/;
const tokenOr = (t) => (TOKEN_RE.test(String(t || '')) ? String(t) : '');

/** UTC slot instants as "YYYY-MM-DDTHH:mmZ", sorted and unique. */
export function utcSlotList(list, max = MAX_FREE_SLOTS) {
  const out = new Set();
  for (const v of Array.isArray(list) ? list : String(list || '').split(/[,\s]+/)) {
    const s = String(v);
    if (!UTC_SLOT_RE.test(s) || Number.isNaN(Date.parse(s))) continue;
    out.add(`${new Date(s).toISOString().slice(0, 16)}Z`);
  }
  return [...out].sort().slice(0, max);
}
const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const slotList = (list, max) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((s) => parseLocal(s)?.hasTime).map((s) => toLocalString(parseLocal(s))))].sort().slice(0, max);

/** Decoded size in bytes of a base64 string. */
export function base64Bytes(b64) {
  const s = String(b64 || '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** Width/height that fit in a max x max box, keeping the aspect ratio (never upscales). */
export function fitWithin(width, height, max = 1000) {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "data:image/jpeg;base64,AAAA" -> { type, data } or null. */
export function parseDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  return m ? { type: m[1], data: m[2] } : null;
}

function common(type, { showName, timeZone, honeypot }) {
  return { type, show: clip(showName, LIMITS.show), timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC', [HONEYPOT_FIELD]: String(honeypot || '') };
}

/** What intake.html sends. `headshot` is { name, type, data (base64) } or null. */
export function buildIntakePayload(a, { showName, timeZone, headshot, honeypot, token } = {}) {
  const p = {
    ...common('intake', { showName, timeZone, honeypot }),
    token: tokenOr(token),
    name: clip(a.name, LIMITS.name),
    pronouns: clip(a.pronouns, LIMITS.pronouns),
    email: clip(a.email, LIMITS.email),
    social: clip(a.social, LIMITS.social),
    role: clip(a.role, LIMITS.role),
    topic: clip(a.topic, LIMITS.topic),
    bio: clip(a.bio, LIMITS.bio),
    availability: slotList(a.availability, LIMITS.availability),
    setup: clip(a.setup, LIMITS.setup),
    notes: clip(a.notes, LIMITS.notes),
    consent: a.consent === true
  };
  if (headshot && headshot.data) p.headshot = { name: clip(headshot.name, LIMITS.headshotName), type: headshot.type || 'image/jpeg', data: headshot.data };
  return p;
}

/**
 * What availability.html sends. `slotsUtc` are the exact instants (they stay
 * distinct across a DST fall-back hour); `slots` are the same in host time,
 * kept for the plain-text fallback and older importers.
 */
export function buildAvailabilityPayload({ name, email, token, slots, slotsUtc, notes, guestTimeZone }, { showName, timeZone, honeypot } = {}) {
  return {
    ...common('availability', { showName, timeZone, honeypot }),
    token: tokenOr(token),
    slotsUtc: utcSlotList(slotsUtc),
    name: clip(name, LIMITS.name),
    email: clip(email, LIMITS.email),
    guestTimeZone: isValidTimeZone(guestTimeZone) ? guestTimeZone : '',
    slots: slotList(slots, LIMITS.slots),
    notes: clip(notes, LIMITS.notes)
  };
}

/** What qa.html sends. `answers` is [{ id, question, answer }]. */
export function buildQaPayload({ name, email, token, answers, topics }, { showName, timeZone, honeypot } = {}) {
  return {
    ...common('qa', { showName, timeZone, honeypot }),
    token: tokenOr(token),
    name: clip(name, LIMITS.name),
    email: clip(email, LIMITS.email),
    answers: (Array.isArray(answers) ? answers : []).filter((x) => x && ITEM_ID_RE.test(String(x.id))).slice(0, LIMITS.answers)
      .map((x) => ({ id: String(x.id), question: clip(x.question, LIMITS.question), answer: clip(x.answer, LIMITS.answer) })),
    topics: clip(topics, LIMITS.topics)
  };
}

/**
 * Client-side check that mirrors the server's rules, so guests get a clear
 * message before sending. Returns '' when fine, else a readable message.
 */
export function validatePayload(p) {
  if (!p || !SUBMISSION_TYPES.includes(p.type)) return 'Unknown submission type.';
  if (!clip(p.name, 1000)) return 'Please enter your name.';
  if (String(p.name).length > LIMITS.name) return `Your name is too long (${LIMITS.name} characters at most).`;
  if (!EMAIL_RE.test(String(p.email || '')) || String(p.email).length > LIMITS.email) return 'Please enter a valid email address.';
  if (p.type === 'intake') {
    for (const f of ['pronouns', 'social', 'role', 'topic', 'bio', 'notes', 'setup']) {
      if (String(p[f] || '').length > LIMITS[f]) return `The ${f} field is too long (${LIMITS[f]} characters at most).`;
    }
    if (p.headshot) {
      if (!/^image\/(jpeg|png|webp)$/.test(p.headshot.type || '')) return 'The photo must be a JPEG, PNG or WebP image.';
      if (base64Bytes(p.headshot.data) > LIMITS.headshotBytes) return 'The photo is too large, even after resizing. Please pick a smaller one.';
    }
  }
  if (p.type === 'availability' && !((Array.isArray(p.slots) && p.slots.length) || (Array.isArray(p.slotsUtc) && p.slotsUtc.length))) return 'Please mark at least one time when you’re free.';
  if (p.type === 'qa' && !(p.answers || []).some((a) => a.answer) && !p.topics) return 'Please answer at least one question.';
  return '';
}

/* ------------------------------------------------------------------ */
/* Reading the list endpoint                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse the JSON from GET ?action=list. The server answers a wrong or
 * missing key with its plain health check (no `submissions`), so that case is
 * reported as keyRejected instead of "0 new".
 */
export function parseListResponse(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'The endpoint did not return JSON.' };
  if (json.ok === false) return { ok: false, error: String(json.error || 'The endpoint reported an error.') };
  if (!Array.isArray(json.submissions)) {
    if (json.service === 'guest-intake') return { ok: false, keyRejected: true, error: 'The endpoint answered, but did not accept the read key.' };
    return { ok: false, error: 'This does not look like the guest intake endpoint.' };
  }
  const submissions = json.submissions.map(normalizeSubmission).filter(Boolean);
  return { ok: true, submissions, now: typeof json.now === 'string' && !Number.isNaN(Date.parse(json.now)) ? json.now : '' };
}

/** Coerce one row from the server into a clean submission, or null. */
export function normalizeSubmission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clip(raw.id, 64);
  const type = SUBMISSION_TYPES.includes(raw.type) ? raw.type : 'intake';
  const email = clip(raw.email, LIMITS.email);
  if (!id || !EMAIL_RE.test(email)) return null;
  const submittedAt = typeof raw.submittedAt === 'string' && !Number.isNaN(Date.parse(raw.submittedAt)) ? new Date(raw.submittedAt).toISOString() : '';
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/));
  const sub = {
    id, type, email, submittedAt,
    name: clip(raw.name, LIMITS.name),
    guestId: GUEST_ID_RE.test(String(raw.guestId || '')) ? String(raw.guestId) : '',
    token: tokenOr(raw.token),
    timeZone: isValidTimeZone(raw.timeZone) ? raw.timeZone : ''
  };
  if (type === 'intake') {
    Object.assign(sub, {
      pronouns: clip(raw.pronouns, LIMITS.pronouns),
      social: clip(raw.social, LIMITS.social),
      role: clip(raw.role, LIMITS.role),
      topic: clip(raw.topic, LIMITS.topic),
      bio: clip(raw.bio, LIMITS.bio),
      availability: slotList(list(raw.availability), LIMITS.availability),
      setup: clip(raw.setup, LIMITS.setup),
      notes: clip(raw.notes, LIMITS.notes),
      consent: raw.consent === true || raw.consent === 'TRUE' || raw.consent === 'true',
      headshotName: clip(raw.headshotName, LIMITS.headshotName),
      headshotUrl: safeHttpUrl(raw.headshotUrl)
    });
  } else if (type === 'availability') {
    Object.assign(sub, { slots: slotList(list(raw.slots), LIMITS.slots), slotsUtc: utcSlotList(raw.slotsUtc), guestTimeZone: isValidTimeZone(raw.guestTimeZone) ? raw.guestTimeZone : '', notes: clip(raw.notes, LIMITS.notes) });
  } else {
    let answers = raw.answers;
    if (typeof answers === 'string') { try { answers = JSON.parse(answers); } catch { answers = []; } }
    Object.assign(sub, {
      answers: (Array.isArray(answers) ? answers : []).filter((a) => a && ITEM_ID_RE.test(String(a.id))).slice(0, LIMITS.answers)
        .map((a) => ({ id: String(a.id), question: clip(a.question, LIMITS.question), answer: clip(a.answer, LIMITS.answer) })),
      topics: clip(raw.topics, LIMITS.topics)
    });
  }
  return sub;
}

/* ------------------------------------------------------------------ */
/* Importing submissions into the guest list                           */
/* ------------------------------------------------------------------ */

const sameEmail = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Host-time slots: convert from the zone the guest's link used, if different. */
function toHostSlots(slots, fromZone, hostZone) {
  if (!fromZone || !hostZone || fromZone === hostZone) return slots.slice();
  return slots.map((s) => convertSlot(s, fromZone, hostZone));
}

function when(iso) {
  return iso ? iso.slice(0, 10) : 'an unknown date';
}

/** Note lines for an intake submission (setup, headshot, guest notes). */
function intakeNote(sub) {
  const lines = [`Intake form received ${when(sub.submittedAt)}.`];
  const setup = setupLabel(sub.setup);
  if (setup) lines.push(`Recording setup: ${setup}.`);
  if (sub.headshotUrl) lines.push(`Headshot: ${sub.headshotUrl}`);
  else if (sub.headshotName) lines.push(`Headshot file: ${sub.headshotName} (not uploaded; ask the guest to email it).`);
  if (sub.notes) lines.push('', sub.notes);
  return lines.join('\n');
}

/** New Outreach guest from a submission. */
export function submissionToGuest(sub, { idFn, nowIso = new Date().toISOString(), hostTimeZone, tokenFn = newGuestToken } = {}) {
  const base = { name: sub.name, email: sub.email, stage: 'outreach', source: sub.type, token: tokenFn() };
  let g = createGuest(base, { idFn, nowIso });
  return mergeSubmissionIntoGuest(g, sub, { nowIso, hostTimeZone, fresh: true });
}

/**
 * Merge a submission into an existing guest. Empty fields are filled in and
 * the host's own edits are kept; the stage, recording time and checklist
 * progress are never reset. `fresh` is true for a guest just created from it.
 */
export function mergeSubmissionIntoGuest(guest, sub, { nowIso = new Date().toISOString(), hostTimeZone, fresh = false } = {}) {
  const g = normalizeGuest(guest);
  const fill = (key, value) => { if (value && !String(g[key] || '').trim()) g[key] = value; };
  fill('name', sub.name);
  fill('email', sub.email);
  const addNote = (text) => { g.notes = g.notes.trim() ? `${g.notes.trim()}\n\n${text}` : text; };

  if (sub.type === 'intake') {
    for (const k of ['pronouns', 'social', 'role', 'topic', 'bio', 'setup']) fill(k, sub[k]);
    if (sub.headshotUrl) g.headshot = sub.headshotUrl;
    else fill('headshot', sub.headshotName);
    const offered = toHostSlots(sub.availability, sub.timeZone, hostTimeZone);
    g.availability = [...new Set([...g.availability, ...offered])].sort();
    if (g.bio.trim() && safeHttpUrl(g.headshot)) g.checks = { ...g.checks, bio: true };
    // A submission can only record consent, never take it away: anyone who
    // knows a guest's email could otherwise clear it.
    if (sub.consent === true) g.checks = { ...g.checks, release: true };
    addNote(intakeNote(sub));
  } else if (sub.type === 'availability') {
    // The latest calendar replaces earlier free times: it's the guest's current answer.
    const zone = hostTimeZone || sub.timeZone || 'UTC';
    g.freeSlots = sub.slotsUtc && sub.slotsUtc.length
      ? [...new Set(sub.slotsUtc.map((u) => utcToLocal(Date.parse(u), zone)))].sort()
      : toHostSlots(sub.slots, sub.timeZone, hostTimeZone).sort();
    const n = Math.max(sub.slots.length, (sub.slotsUtc || []).length);
    const tzNote = sub.guestTimeZone && sub.guestTimeZone !== hostTimeZone ? ` The guest is in ${sub.guestTimeZone}.` : '';
    addNote(`Availability received ${when(sub.submittedAt)}: ${n} half-hour slot${n === 1 ? '' : 's'}.${tzNote}${sub.notes ? `\n${sub.notes}` : ''}`);
  } else if (sub.type === 'qa') {
    g.qa = mergeQaAnswers(g.qa, { answers: sub.answers, topics: sub.topics, submittedAt: sub.submittedAt || nowIso });
  }
  if (fresh && sub.type !== 'intake') g.notes = g.notes.trim();
  g.updatedAt = nowIso;
  return g;
}

/**
 * Who a submission belongs to, and how sure we are:
 *   { guest, trusted: true }   it carries the guest's secret link token
 *   { guest, trusted: false }  it only matches the guest's id or email
 *   null                       nobody: a new guest
 */
export function findGuestFor(guests, sub) {
  if (sub.token) {
    const byToken = guests.find((g) => !g.sample && g.token && g.token === sub.token);
    if (byToken) return { guest: byToken, trusted: true };
  }
  if (sub.guestId) {
    const byId = guests.find((g) => g.id === sub.guestId && !g.sample);
    if (byId) return { guest: byId, trusted: false };
  }
  const byEmail = guests.find((g) => !g.sample && sameEmail(g.email, sub.email));
  return byEmail ? { guest: byEmail, trusted: false } : null;
}

/**
 * Import submissions into `state`. Submissions whose id is in `seenIds` are
 * skipped (so checking twice never duplicates). A submission with the guest's
 * link token merges straight in; one that only matches an existing guest's
 * email or id waits in that guest's `pending` list for the host to accept or
 * discard, because anyone who knows an email address could send it.
 */
export function applySubmissions(state, submissions, { seenIds = [], idFn, nowIso = new Date().toISOString(), tokenFn } = {}) {
  const seen = new Set(seenIds);
  let guests = state.guests.slice();
  const counts = { created: 0, updated: 0, pending: 0, skipped: 0, byType: { intake: 0, availability: 0, qa: 0 } };
  const touched = [];
  const created = new Set();
  const merged = new Set();
  const sorted = submissions.slice().sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  for (const sub of sorted) {
    if (!sub || seen.has(sub.id)) { counts.skipped += 1; continue; }
    seen.add(sub.id);
    const match = findGuestFor(guests, sub);
    if (match && (match.trusted || created.has(match.guest.id))) {
      const next = mergeSubmissionIntoGuest(match.guest, sub, { nowIso, hostTimeZone: state.settings.timeZone });
      guests = guests.map((g) => (g.id === match.guest.id ? next : g));
      merged.add(match.guest.id);
      if (!touched.includes(match.guest.id)) touched.push(match.guest.id);
    } else if (match) {
      const g = normalizeGuest(match.guest);
      if (!g.pending.some((p) => p.id === sub.id)) g.pending = [...g.pending, sub].slice(-20);
      guests = guests.map((x) => (x.id === g.id ? g : x));
      if (!touched.includes(g.id)) touched.push(g.id);
      counts.pending += 1;
    } else {
      const g = submissionToGuest(sub, { idFn, nowIso, hostTimeZone: state.settings.timeZone, tokenFn });
      guests.push(g);
      touched.push(g.id);
      created.add(g.id);
      counts.created += 1;
    }
    counts.byType[sub.type] += 1;
  }
  counts.updated = [...merged].filter((id) => !created.has(id)).length;
  return { state: { ...state, guests }, seenIds: trimSeen([...seen]), counts, touched };
}

/** Accept a pending submission: merge it into the guest and drop it from the list. */
export function acceptPending(guest, subId, { nowIso = new Date().toISOString(), hostTimeZone } = {}) {
  const g = normalizeGuest(guest);
  const raw = g.pending.find((p) => p.id === subId);
  const rest = g.pending.filter((p) => p.id !== subId);
  const sub = raw && normalizeSubmission(raw); // re-clean: stored data is untrusted
  if (!sub) return { ...g, pending: rest };
  return { ...mergeSubmissionIntoGuest({ ...g, pending: rest }, sub, { nowIso, hostTimeZone }), pending: rest };
}

export function discardPending(guest, subId) {
  const g = normalizeGuest(guest);
  return { ...g, pending: g.pending.filter((p) => p.id !== subId) };
}

/** One line describing a pending submission, for the host. */
export function describePending(raw) {
  const sub = normalizeSubmission(raw);
  if (!sub) return 'An unreadable submission';
  const what = sub.type === 'availability' ? `availability (${Math.max(sub.slots.length, sub.slotsUtc.length)} half hours)`
    : sub.type === 'qa' ? `Q&A answers (${sub.answers.filter((a) => a.answer).length})` : 'an intake form';
  return `${sub.name || 'Someone'} <${sub.email}> sent ${what}${sub.submittedAt ? ` on ${sub.submittedAt.slice(0, 10)}` : ''}.`;
}

/** Human summary of an import, e.g. "Added 2 new guests and updated 1 existing guest." */
export function importSummary(counts) {
  const { created, updated, pending = 0 } = counts;
  const merged = updated;
  if (!created && !updated && !pending) return 'No new submissions.';
  const parts = [];
  if (created) parts.push(`added ${created} new guest${created === 1 ? '' : 's'}`);
  if (merged > 0) parts.push(`updated ${merged} existing guest${merged === 1 ? '' : 's'}`);
  let s = parts.join(' and ');
  s = s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : '';
  if (pending) s = `${s ? `${s} ` : ''}${pending} submission${pending === 1 ? '' : 's'} matched an existing guest only by email or id and ${pending === 1 ? 'needs' : 'need'} your review in the guest panel.`;
  return s;
}

/* ------------------------------------------------------------------ */
/* Sync settings (kept apart from the main data and never exported)    */
/* ------------------------------------------------------------------ */

export const SYNC_KEY = 'podcast-guest-manager:sync:v1';
const MAX_SEEN = 3000;

function trimSeen(ids) {
  return ids.slice(-MAX_SEEN);
}

export function normalizeSync(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    readKey: typeof s.readKey === 'string' ? s.readKey.trim().slice(0, 200) : '',
    lastSync: typeof s.lastSync === 'string' && !Number.isNaN(Date.parse(s.lastSync)) ? s.lastSync : '',
    seenIds: Array.isArray(s.seenIds) ? trimSeen(s.seenIds.filter((x) => typeof x === 'string' && x).slice(0, MAX_SEEN * 2)) : [],
    autoCheck: s.autoCheck !== false,
    // The endpoint the read key was entered for. The key is only ever sent there.
    keyEndpoint: normalizeEndpoint(s.keyEndpoint)
  };
}

/**
 * The read key may be sent only to the endpoint it was entered for. If the
 * endpoint changed (for example by importing a backup), ask for the key again.
 */
export function keyUsable(sync, endpoint) {
  const e = normalizeEndpoint(endpoint);
  return !!(e && sync.readKey && sync.keyEndpoint && sync.keyEndpoint === e);
}

/**
 * `since` for the next list call: the last sync time minus a few minutes of
 * overlap, so a row written while the previous check ran is not missed
 * (duplicates are skipped by id anyway).
 */
export function sinceFor(lastSync, overlapMinutes = 5) {
  if (!lastSync || Number.isNaN(Date.parse(lastSync))) return '';
  return new Date(Date.parse(lastSync) - overlapMinutes * 60000).toISOString();
}

/** URL for the list call. The read key goes only here, never into a share link. */
export function listUrl(endpoint, readKey, since) {
  const base = normalizeEndpoint(endpoint);
  if (!base) return '';
  const u = new URL(base);
  u.searchParams.set('action', 'list');
  u.searchParams.set('key', readKey);
  if (since) u.searchParams.set('since', since);
  return u.href;
}

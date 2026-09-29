// Pure logic for the Google Apps Script backend (backend/Code.gs): building
// and validating what guest pages send, reading what the list endpoint
// returns, and importing submissions into the guest list (dedupe by
// submission id, merge by guest id or email). No DOM, storage or network.
import {
  createGuest, normalizeGuest, parseLocal, toLocalString, setupLabel, safeHttpUrl, isValidTimeZone, normalizeEndpoint
} from './logic.js';
import { convertSlot, MAX_FREE_SLOTS } from './slots.js';
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
export function buildIntakePayload(a, { showName, timeZone, headshot, honeypot } = {}) {
  const p = {
    ...common('intake', { showName, timeZone, honeypot }),
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

/** What availability.html sends. `slots` are host-time slot starts. */
export function buildAvailabilityPayload({ name, email, guestId, slots, notes, guestTimeZone }, { showName, timeZone, honeypot } = {}) {
  return {
    ...common('availability', { showName, timeZone, honeypot }),
    guestId: GUEST_ID_RE.test(String(guestId || '')) ? guestId : '',
    name: clip(name, LIMITS.name),
    email: clip(email, LIMITS.email),
    guestTimeZone: isValidTimeZone(guestTimeZone) ? guestTimeZone : '',
    slots: slotList(slots, LIMITS.slots),
    notes: clip(notes, LIMITS.notes)
  };
}

/** What qa.html sends. `answers` is [{ id, question, answer }]. */
export function buildQaPayload({ name, email, guestId, answers, topics }, { showName, timeZone, honeypot } = {}) {
  return {
    ...common('qa', { showName, timeZone, honeypot }),
    guestId: GUEST_ID_RE.test(String(guestId || '')) ? guestId : '',
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
  if (p.type === 'availability' && !(Array.isArray(p.slots) && p.slots.length)) return 'Please mark at least one time when you’re free.';
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
    Object.assign(sub, { slots: slotList(list(raw.slots), LIMITS.slots), guestTimeZone: isValidTimeZone(raw.guestTimeZone) ? raw.guestTimeZone : '', notes: clip(raw.notes, LIMITS.notes) });
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
export function submissionToGuest(sub, { idFn, nowIso = new Date().toISOString(), hostTimeZone } = {}) {
  const base = { name: sub.name, email: sub.email, stage: 'outreach', source: sub.type };
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
    g.checks = { ...g.checks, release: sub.consent === true };
    addNote(intakeNote(sub));
  } else if (sub.type === 'availability') {
    // The latest calendar replaces earlier free times: it's the guest's current answer.
    g.freeSlots = toHostSlots(sub.slots, sub.timeZone, hostTimeZone).sort();
    const tzNote = sub.guestTimeZone && sub.guestTimeZone !== hostTimeZone ? ` The guest is in ${sub.guestTimeZone}.` : '';
    addNote(`Availability received ${when(sub.submittedAt)}: ${sub.slots.length} half-hour slot${sub.slots.length === 1 ? '' : 's'}.${tzNote}${sub.notes ? `\n${sub.notes}` : ''}`);
  } else if (sub.type === 'qa') {
    g.qa = mergeQaAnswers(g.qa, { answers: sub.answers, topics: sub.topics, submittedAt: sub.submittedAt || nowIso });
  }
  if (fresh && sub.type !== 'intake') g.notes = g.notes.trim();
  g.updatedAt = nowIso;
  return g;
}

/** Guest a submission belongs to: by guest id first, then by email. */
export function findGuestFor(guests, sub) {
  if (sub.guestId) {
    const byId = guests.find((g) => g.id === sub.guestId && !g.sample);
    if (byId) return byId;
  }
  return guests.find((g) => !g.sample && sameEmail(g.email, sub.email)) || null;
}

/**
 * Import submissions into `state`. Submissions whose id is in `seenIds` are
 * skipped (so checking twice never duplicates). Returns the new state, the
 * updated seen ids and counts for the host.
 */
export function applySubmissions(state, submissions, { seenIds = [], idFn, nowIso = new Date().toISOString() } = {}) {
  const seen = new Set(seenIds);
  let guests = state.guests.slice();
  const counts = { created: 0, updated: 0, skipped: 0, byType: { intake: 0, availability: 0, qa: 0 } };
  const touched = [];
  const sorted = submissions.slice().sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  for (const sub of sorted) {
    if (!sub || seen.has(sub.id)) { counts.skipped += 1; continue; }
    seen.add(sub.id);
    const existing = findGuestFor(guests, sub);
    if (existing) {
      const merged = mergeSubmissionIntoGuest(existing, sub, { nowIso, hostTimeZone: state.settings.timeZone });
      guests = guests.map((g) => (g.id === existing.id ? merged : g));
      if (!touched.includes(existing.id)) { touched.push(existing.id); counts.updated += 1; }
    } else {
      const g = submissionToGuest(sub, { idFn, nowIso, hostTimeZone: state.settings.timeZone });
      guests.push(g);
      touched.push(g.id);
      counts.created += 1;
    }
    counts.byType[sub.type] += 1;
  }
  // A guest created and then updated in the same batch counts once, as created.
  counts.updated = touched.length - counts.created;
  return { state: { ...state, guests }, seenIds: trimSeen([...seen]), counts, touched };
}

/** Human summary of an import, e.g. "Imported 2 new guests and updated 1." */
export function importSummary(counts) {
  const { created, updated } = counts;
  if (!created && !updated) return 'No new submissions.';
  const parts = [];
  if (created) parts.push(`added ${created} new guest${created === 1 ? '' : 's'}`);
  if (updated) parts.push(`updated ${updated} existing guest${updated === 1 ? '' : 's'}`);
  const s = parts.join(' and ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
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
    autoCheck: s.autoCheck !== false
  };
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

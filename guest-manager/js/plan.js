// Pure logic for the episode plan and the guest Q&A (pre-interview
// questionnaire). No DOM or storage access; unit-tested with node:test.

export const DEFAULT_QUESTION_BANK = Object.freeze([
  'How would you like to be introduced?',
  'How do you pronounce your name?',
  'What’s the one thing you want listeners to take away?',
  'What story or example do you love telling about this topic?',
  'What are you working on or promoting right now?',
  'What question do you wish interviewers asked you?',
  'Anything off-limits?'
]);

export const QA_LIMITS = Object.freeze({
  questions: 20, // per guest (and per link)
  question: 300, // characters per question
  answer: 2000, // characters per answer
  topics: 2000, // "Topics I'd love to talk about"
  linkParam: 3000 // max length of the encoded question list in a share link
});

export const PLAN_LIMITS = Object.freeze({ items: 60, text: 500, title: 200, angle: 2000, minutes: 600 });

const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);
const isoOrEmpty = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : '');

export function shortId(prefix = 'i') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  }
  return prefix + Math.random().toString(36).slice(2, 10);
}

const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

/** Clean a list of { id, text, ...extra } items; drops blanks-without-id and duplicate ids. */
function normalizeItems(list, { withMinutes = false, max = PLAN_LIMITS.items, textMax = PLAN_LIMITS.text, prefix = 'i' } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    let id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
    if (!id || seen.has(id)) id = shortId(prefix);
    seen.add(id);
    const item = { id, text: str(raw.text, textMax) };
    if (withMinutes) {
      const m = Number(raw.minutes);
      item.minutes = Number.isFinite(m) && m > 0 ? Math.min(Math.round(m), PLAN_LIMITS.minutes) : 0;
    }
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeQuestionBank(list) {
  if (!Array.isArray(list)) return DEFAULT_QUESTION_BANK.slice();
  return list.map((q) => str(q, QA_LIMITS.question).trim()).filter(Boolean).slice(0, QA_LIMITS.questions);
}

/* ------------------------------------------------------------------ */
/* Episode plan                                                        */
/* ------------------------------------------------------------------ */

export function normalizePlan(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    title: str(p.title, PLAN_LIMITS.title),
    angle: str(p.angle, PLAN_LIMITS.angle),
    segments: normalizeItems(p.segments, { withMinutes: true, prefix: 's' }),
    airQuestions: normalizeItems(p.airQuestions, { prefix: 'a' })
  };
}

export function addItem(list, text = '', { idFn = () => shortId('i'), minutes } = {}) {
  if (list.length >= PLAN_LIMITS.items) return list;
  const item = { id: idFn(), text: str(text, PLAN_LIMITS.text) };
  if (minutes !== undefined) item.minutes = Math.max(0, Math.min(Math.round(Number(minutes) || 0), PLAN_LIMITS.minutes));
  return [...list, item];
}

export function updateItem(list, id, patch) {
  return list.map((it) => {
    if (it.id !== id) return it;
    const next = { ...it };
    if ('text' in patch) next.text = str(patch.text, PLAN_LIMITS.text);
    if ('minutes' in patch && 'minutes' in it) {
      const m = Number(patch.minutes);
      next.minutes = Number.isFinite(m) && m > 0 ? Math.min(Math.round(m), PLAN_LIMITS.minutes) : 0;
    }
    return next;
  });
}

/** Move an item up (delta -1) or down (+1). Out-of-range moves return the list unchanged. */
export function moveItem(list, id, delta) {
  const i = list.findIndex((it) => it.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function removeItem(list, id) {
  return list.filter((it) => it.id !== id);
}

/** Running totals: [{ ...segment, start, end }] plus the overall total in minutes. */
export function segmentTimings(segments) {
  let t = 0;
  const rows = segments.map((s) => {
    const start = t;
    t += s.minutes || 0;
    return { ...s, start, end: t };
  });
  return { rows, total: t };
}

export function formatMinutes(total) {
  const m = Math.max(0, Math.round(total || 0));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

/* ------------------------------------------------------------------ */
/* Guest Q&A                                                           */
/* ------------------------------------------------------------------ */

export function normalizeQa(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const questions = normalizeItems(q.questions, { max: QA_LIMITS.questions, textMax: QA_LIMITS.question, prefix: 'q' });
  const answers = {};
  const src = q.answers && typeof q.answers === 'object' ? q.answers : {};
  for (const [id, a] of Object.entries(src)) {
    if (!ID_RE.test(id) || !a || typeof a !== 'object') continue;
    answers[id] = { text: str(a.text, QA_LIMITS.answer), answeredAt: isoOrEmpty(a.answeredAt) };
  }
  return {
    questions,
    answers,
    topics: str(q.topics, QA_LIMITS.topics),
    topicsAt: isoOrEmpty(q.topicsAt),
    sentAt: isoOrEmpty(q.sentAt),
    answeredAt: isoOrEmpty(q.answeredAt)
  };
}

/** Per-guest question list seeded from the reusable bank. */
export function seedQuestions(bank, { idFn = () => shortId('q') } = {}) {
  return normalizeQuestionBank(bank).map((text) => ({ id: idFn(), text }));
}

/** 'answered' once answers arrived, 'sent' once the link was shared, else 'not-sent'. */
export function qaStatus(guest) {
  const qa = guest?.qa;
  if (!qa) return 'not-sent';
  if (qa.answeredAt) return 'answered';
  if (qa.sentAt) return 'sent';
  return 'not-sent';
}

export const QA_STATUS_LABELS = Object.freeze({ 'not-sent': 'Q&A not sent', sent: 'Q&A sent', answered: 'Q&A answered' });

/** Ensure the guest has questions (seeded from the bank) and stamp sentAt. */
export function markQaSent(guest, bank, nowIso = new Date().toISOString(), { idFn } = {}) {
  const qa = normalizeQa(guest.qa);
  if (!qa.questions.length) qa.questions = seedQuestions(bank, { idFn });
  if (!qa.sentAt) qa.sentAt = nowIso;
  return { ...guest, qa, updatedAt: nowIso };
}

/* URL-safe base64 of UTF-8 text, usable in browsers and Node. */
function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64) {
  const norm = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode questions for a share link: base64url of JSON [[id, text], ...].
 * Questions that would push the parameter past `maxLength` are dropped from
 * the end; `dropped` says how many so the host can be told.
 */
export function encodeQuestions(questions, { maxLength = QA_LIMITS.linkParam } = {}) {
  const pairs = questions.filter((q) => q.text.trim()).slice(0, QA_LIMITS.questions).map((q) => [q.id, q.text.trim().slice(0, QA_LIMITS.question)]);
  const total = questions.filter((q) => q.text.trim()).length;
  let n = pairs.length;
  let param = toBase64Url(JSON.stringify(pairs));
  while (n > 0 && param.length > maxLength) {
    n -= 1;
    param = toBase64Url(JSON.stringify(pairs.slice(0, n)));
  }
  return { param: n ? param : '', included: n, dropped: total - n };
}

/** Decode the `qs` link parameter. Invalid input gives an empty list. */
export function decodeQuestions(param) {
  if (!param || typeof param !== 'string' || param.length > QA_LIMITS.linkParam + 16) return [];
  let data;
  try { data = JSON.parse(fromBase64Url(param)); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out = [];
  const seen = new Set();
  for (const pair of data.slice(0, QA_LIMITS.questions)) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
    if (!ID_RE.test(pair[0]) || seen.has(pair[0])) continue;
    const text = pair[1].trim().slice(0, QA_LIMITS.question);
    if (!text) continue;
    seen.add(pair[0]);
    out.push({ id: pair[0], text });
  }
  return out;
}

/**
 * Merge received answers into a guest's Q&A. Answers are matched by
 * question id; an answer only replaces an existing one when it is at least as
 * new (latest wins). Unknown question ids are added to the list so nothing
 * the guest wrote is lost.
 */
export function mergeQaAnswers(qaRaw, { answers = [], topics = '', submittedAt }) {
  const qa = normalizeQa(qaRaw);
  const at = isoOrEmpty(submittedAt) || new Date().toISOString();
  const newer = (old) => !old || !old.answeredAt || old.answeredAt <= at;
  let changed = false;
  for (const a of answers) {
    if (!a || !ID_RE.test(String(a.id || ''))) continue;
    const text = str(a.answer, QA_LIMITS.answer).trim();
    if (!qa.questions.some((q) => q.id === a.id) && qa.questions.length < QA_LIMITS.questions) {
      qa.questions.push({ id: a.id, text: str(a.question, QA_LIMITS.question).trim() || 'Question' });
    }
    if (!text) continue;
    if (newer(qa.answers[a.id])) {
      qa.answers[a.id] = { text, answeredAt: at };
      changed = true;
    }
  }
  const t = str(topics, QA_LIMITS.topics).trim();
  if (t && (!qa.topicsAt || qa.topicsAt <= at)) {
    qa.topics = t;
    qa.topicsAt = at;
    changed = true;
  }
  if (changed && (!qa.answeredAt || qa.answeredAt < at)) qa.answeredAt = at;
  return qa;
}

/**
 * Copy a guest's answer into the episode plan as a talking point
 * ('segment') or an on-air question ('air').
 */
export function promoteAnswer(guest, questionId, target, { idFn = () => shortId(target === 'air' ? 'a' : 's'), nowIso = new Date().toISOString() } = {}) {
  const q = guest.qa.questions.find((x) => x.id === questionId);
  const a = guest.qa.answers[questionId];
  if (!a || !a.text) return guest;
  const plan = normalizePlan(guest.plan);
  const text = target === 'air'
    ? `Follow-up on “${q ? q.text : 'your answer'}”: ${a.text}`
    : a.text;
  if (target === 'air') plan.airQuestions = addItem(plan.airQuestions, text, { idFn });
  else plan.segments = addItem(plan.segments, text, { idFn, minutes: 0 });
  return { ...guest, plan, updatedAt: nowIso };
}

/** Plain text of the Q&A answers, for a guest's copy/email fallback. */
export function qaToText({ showName, name, email, questions, answers, topics }) {
  const lines = [`Pre-interview answers for ${String(showName || '').trim() || 'the show'}`, '', `Name: ${name || ''}`, `Email: ${email || ''}`, ''];
  for (const q of questions) {
    lines.push(q.text, (answers[q.id] || '').trim() || '-', '');
  }
  lines.push('Topics I’d love to talk about:', String(topics || '').trim() || '-');
  return lines.join('\n');
}

/**
 * Everything the printable run sheet shows, in order. Pure data so the
 * print view and the text export agree.
 */
export function runSheet(guest, { showName = '', recordingLabel = '' } = {}) {
  const plan = normalizePlan(guest.plan);
  const qa = normalizeQa(guest.qa);
  const timings = segmentTimings(plan.segments.filter((s) => s.text.trim()));
  return {
    show: String(showName || '').trim(),
    title: plan.title.trim() || `Episode with ${String(guest.name || '').trim() || 'our guest'}`,
    guest: String(guest.name || '').trim(),
    role: String(guest.role || '').trim(),
    pronouns: String(guest.pronouns || '').trim(),
    recording: recordingLabel,
    angle: plan.angle.trim(),
    intro: String(guest.bio || '').trim(),
    segments: timings.rows,
    totalMinutes: timings.total,
    airQuestions: plan.airQuestions.filter((q) => q.text.trim()),
    answers: qa.questions.map((q) => ({ question: q.text, answer: qa.answers[q.id]?.text || '', answeredAt: qa.answers[q.id]?.answeredAt || '' })).filter((x) => x.answer),
    topics: qa.topics.trim()
  };
}

export function runSheetToText(sheet) {
  const lines = [];
  lines.push(sheet.title);
  if (sheet.show) lines.push(sheet.show);
  lines.push('');
  lines.push(`Guest: ${sheet.guest || '-'}${sheet.pronouns ? ` (${sheet.pronouns})` : ''}${sheet.role ? `, ${sheet.role}` : ''}`);
  if (sheet.recording) lines.push(`Recording: ${sheet.recording}`);
  if (sheet.angle) lines.push('', 'Angle', sheet.angle);
  if (sheet.intro) lines.push('', 'Intro / bio', sheet.intro);
  lines.push('', `Talking points (${formatMinutes(sheet.totalMinutes)})`);
  if (sheet.segments.length) {
    sheet.segments.forEach((s, i) => lines.push(`${i + 1}. ${s.text}${s.minutes ? ` [${s.minutes} min, ${s.start}–${s.end}]` : ''}`));
  } else lines.push('-');
  lines.push('', 'On-air questions');
  if (sheet.airQuestions.length) sheet.airQuestions.forEach((q, i) => lines.push(`${i + 1}. ${q.text}`));
  else lines.push('-');
  lines.push('', 'Guest answers');
  if (sheet.answers.length) for (const a of sheet.answers) lines.push(`Q: ${a.question}`, `A: ${a.answer}`, '');
  else lines.push('-');
  if (sheet.topics) lines.push('', 'Topics the guest would love to talk about', sheet.topics);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Guest Q&A (pre-interview questionnaire). The share link carries the
// questions (compact, URL-safe); answers autosave as a draft in this browser
// and are sent to the host's Apps Script endpoint as type "qa", with a
// copy/mailto fallback.
import { readIntakeParams, validateIntake, mailtoForText, createInitialState } from './logic.js';
import { decodeQuestions, DEFAULT_QUESTION_BANK, QA_LIMITS, qaToText } from './plan.js';
import { buildQaPayload, validatePayload, applySubmissions, normalizeSubmission, HONEYPOT_FIELD } from './remote.js';
import { postSubmission } from './api.js';
import { inspectStoredState, saveState, browserTimeZone } from './store.js';
import { $, toast, copyTextarea, setBusy, setStatus, hideBackLinkWhenShared, deliveryNote } from './guest-page.js';

const stored = inspectStoredState();
const storedSettings = stored.status === 'ok' ? stored.state.settings : null;
const search = new URLSearchParams(window.location.search);
const params = readIntakeParams(window.location.search);
const settings = {
  showName: params.showName || storedSettings?.showName || 'the show',
  timeZone: params.timeZone || storedSettings?.timeZone || browserTimeZone(),
  hostEmail: params.hostEmail || storedSettings?.hostEmail || '',
  endpoint: params.endpoint || storedSettings?.intakeEndpoint || ''
};
const guestToken = params.guestToken || '';
const fromLink = decodeQuestions(search.get('qs'));
const questions = fromLink.length
  ? fromLink
  : (storedSettings?.questionBank?.length ? storedSettings.questionBank : DEFAULT_QUESTION_BANK).map((text, i) => ({ id: `b${i + 1}`, text }));

const form = $('#qa-form');
const DRAFT_KEY = `podcast-guest-manager:qa-draft:${guestToken ? guestToken.slice(0, 10) : settings.showName}`;
let sending = false;
let lastPayload = null;

/* ---------------------------------------------------------------- */
/* Questions + character counters                                    */
/* ---------------------------------------------------------------- */

function counterText(n, max) {
  return `${n} / ${max} characters`;
}

function renderQuestions() {
  $('#questions').replaceChildren(...questions.map((q) => {
    const li = document.createElement('li');
    li.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `ans-${q.id}`;
    label.textContent = q.text;
    const ta = document.createElement('textarea');
    ta.id = `ans-${q.id}`;
    ta.rows = 3;
    ta.maxLength = QA_LIMITS.answer;
    ta.dataset.q = q.id;
    ta.setAttribute('aria-describedby', `count-${q.id}`);
    const count = document.createElement('span');
    count.className = 'char-count';
    count.id = `count-${q.id}`;
    count.textContent = counterText(0, QA_LIMITS.answer);
    li.append(label, ta, count);
    return li;
  }));
  $('#in-topics').maxLength = QA_LIMITS.topics;
  $('#count-topics').textContent = counterText(0, QA_LIMITS.topics);
}

function updateCount(ta) {
  const out = document.getElementById(ta.getAttribute('aria-describedby'));
  if (out) out.textContent = counterText(ta.value.length, ta.maxLength);
}

/* ---------------------------------------------------------------- */
/* Draft autosave (this browser only)                                */
/* ---------------------------------------------------------------- */

function collect() {
  const f = form.elements;
  return {
    name: f.name.value.trim(),
    email: f.email.value.trim(),
    answers: Object.fromEntries(questions.map((q) => [q.id, $(`#ans-${q.id}`).value])),
    topics: $('#in-topics').value
  };
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...collect(), savedAt: new Date().toISOString() }));
    $('#draft-status').textContent = `Draft saved in this browser at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    $('#draft-status').textContent = '';
  }
}

function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { d = null; }
  if (!d || typeof d !== 'object') return false;
  const f = form.elements;
  if (typeof d.name === 'string' && d.name) f.name.value = d.name;
  if (typeof d.email === 'string' && d.email) f.email.value = d.email;
  for (const q of questions) {
    const v = d.answers && typeof d.answers[q.id] === 'string' ? d.answers[q.id] : '';
    const ta = $(`#ans-${q.id}`);
    ta.value = v.slice(0, QA_LIMITS.answer);
    updateCount(ta);
  }
  if (typeof d.topics === 'string') { $('#in-topics').value = d.topics.slice(0, QA_LIMITS.topics); updateCount($('#in-topics')); }
  $('#draft-status').textContent = 'Your saved draft was restored.';
  return true;
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

form.addEventListener('input', (e) => {
  if (e.target.tagName === 'TEXTAREA') updateCount(e.target);
  clearTimeout(saveDraft.timer);
  saveDraft.timer = setTimeout(saveDraft, 500);
});

/* ---------------------------------------------------------------- */
/* Submit                                                            */
/* ---------------------------------------------------------------- */

function showErrors(errors) {
  const fields = { name: $('#in-name'), email: $('#in-email') };
  for (const [key, input] of Object.entries(fields)) {
    const msg = errors[key];
    const out = $(`#err-${key}`);
    out.textContent = msg || '';
    out.hidden = !msg;
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  const summary = $('#error-summary');
  const msgs = Object.values(errors);
  summary.hidden = !msgs.length;
  if (!msgs.length) return;
  const title = document.createElement('strong');
  title.textContent = msgs.length === 1 ? 'Please fix one thing:' : `Please fix ${msgs.length} things:`;
  const ul = document.createElement('ul');
  for (const m of msgs) {
    const li = document.createElement('li');
    li.textContent = m;
    ul.append(li);
  }
  summary.replaceChildren(title, ul);
  summary.focus();
}

function saveLocally(payload) {
  const s = inspectStoredState();
  if (s.status === 'corrupt') return false;
  const state = s.status === 'ok' ? s.state : createInitialState({ timeZone: settings.timeZone, withSamples: false });
  const sub = normalizeSubmission({ ...payload, id: `local-${Date.now()}`, submittedAt: new Date().toISOString() });
  if (!sub) return false;
  return saveState(applySubmissions(state, [sub]).state);
}

function showDone({ sent, error = '' }) {
  const p = lastPayload;
  $('#done-title').textContent = sent ? 'Thanks, your answers reached the show.' : error ? 'Your answers weren’t sent yet.' : 'Thanks! Now send your answers to the show.';
  $('#fallback-block').hidden = sent;
  const err = $('#send-error');
  err.hidden = !error;
  err.textContent = error ? `Sending failed: ${error} You can try again, or send your answers by email instead.` : '';
  $('#retry-send').hidden = !(error && settings.endpoint);
  if (sent) clearDraft();
  else {
    const text = qaToText({ showName: settings.showName, name: p.name, email: p.email, questions, answers: Object.fromEntries(p.answers.map((a) => [a.id, a.answer])), topics: p.topics });
    $('#qa-text').value = text;
    const mail = mailtoForText(settings.hostEmail, `Pre-interview answers: ${p.name}`, text);
    $('#email-text').href = mail.href;
    $('#mailto-note').hidden = !mail.truncated;
    const saved = saveLocally(p);
    $('#done-local-note').textContent = `${saved ? 'Your answers were saved in this browser’s guest list. ' : ''}Please send them to the show: copy them below, or ${settings.hostEmail ? `open them in your email app (addressed to ${settings.hostEmail})` : 'paste them into an email to the person who invited you'}. Your draft stays saved in this browser.`;
  }
  form.hidden = true;
  $('#done').hidden = false;
  $('#done-title').focus();
}

async function send() {
  const status = $('#send-status');
  setStatus(status, 'Sending your answers to the show…');
  try {
    await postSubmission(settings.endpoint, lastPayload);
    return '';
  } catch (err) {
    return err.message || 'Something went wrong while sending.';
  } finally {
    setStatus(status, '');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  const d = collect();
  const errors = validateIntake(d);
  lastPayload = buildQaPayload(
    { name: d.name, email: d.email, token: guestToken, topics: d.topics, answers: questions.map((q) => ({ id: q.id, question: q.text, answer: d.answers[q.id] })) },
    { showName: settings.showName, timeZone: settings.timeZone, honeypot: form.elements[HONEYPOT_FIELD]?.value }
  );
  if (!Object.keys(errors).length) {
    const invalid = validatePayload(lastPayload);
    if (invalid) errors.answers = invalid;
  }
  showErrors(errors);
  if (Object.keys(errors).length) return;
  if (!settings.endpoint) return showDone({ sent: false });
  sending = true;
  const btn = form.querySelector('[type=submit]');
  setBusy(btn, true, 'Sending…');
  const error = await send();
  setBusy(btn, false);
  sending = false;
  showDone({ sent: !error, error });
});

$('#retry-send').addEventListener('click', async () => {
  if (sending) return;
  sending = true;
  const btn = $('#retry-send');
  setBusy(btn, true, 'Sending…');
  const error = await send();
  setBusy(btn, false);
  sending = false;
  if (error) {
    $('#send-error').textContent = `Sending failed again: ${error} Please send your answers by email instead.`;
    btn.focus();
  } else showDone({ sent: true });
});

$('#edit-again').addEventListener('click', () => {
  $('#done').hidden = true;
  form.hidden = false;
  $('#page-title').focus();
});

$('#copy-text').addEventListener('click', async () => {
  const ok = await copyTextarea($('#qa-text'));
  toast(ok ? 'Copied. Paste it into an email to the show.' : 'Could not copy automatically. The text is selected: press Ctrl+C or Cmd+C.');
});

/* ---------------------------------------------------------------- */
/* Start                                                             */
/* ---------------------------------------------------------------- */

hideBackLinkWhenShared();
for (const el of document.querySelectorAll('[data-show-name]')) el.textContent = settings.showName;
document.title = `Pre-interview questions · ${settings.showName}`;
if (settings.endpoint) $('#delivery-note').textContent = deliveryNote('Your answers', settings.showName, settings.endpoint);
$('#hp-field input').name = HONEYPOT_FIELD;
renderQuestions();
if (!restoreDraft()) {
  if (params.guestName) form.elements.name.value = params.guestName;
  if (params.guestEmail) form.elements.email.value = params.guestEmail;
}

// Guest intake form. There is no backend: submitting saves the guest into this
// browser's guest list (same storage as the pipeline) and offers the answers as
// text so a remote guest can email them to the host.
import {
  SETUP_OPTIONS, validateIntake, intakeToGuest, intakeToText, readIntakeParams, suggestSlots,
  nowInZone, formatDay, formatTime, buildMailto, createInitialState, upsertGuest, isValidTimeZone
} from './logic.js';
import { loadStoredState, saveState, browserTimeZone } from './store.js';

const $ = (sel) => document.querySelector(sel);

const stored = loadStoredState();
const params = readIntakeParams(window.location.search);
const tz = params.timeZone || stored?.settings.timeZone || browserTimeZone();
const settings = {
  showName: params.showName || stored?.settings.showName || 'the show',
  timeZone: isValidTimeZone(tz) ? tz : 'UTC',
  hostEmail: params.hostEmail || stored?.settings.hostEmail || '',
  intakeSlots: params.intakeSlots || stored?.settings.intakeSlots || []
};
const slots = settings.intakeSlots.length ? settings.intakeSlots : suggestSlots(nowInZone(settings.timeZone).slice(0, 10));

const form = $('#intake-form');
const done = $('#intake-done');
const picked = new Set();
let savedId = null;

function toast(message) {
  const el = $('#toast');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = message; });
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.textContent = ''; }, 4500);
}

function renderStatic() {
  for (const el of document.querySelectorAll('[data-show-name]')) el.textContent = settings.showName;
  for (const el of document.querySelectorAll('[data-tz]')) el.textContent = settings.timeZone.replace(/_/g, ' ');
  document.title = `Guest intake · ${settings.showName}`;

  $('#slots').replaceChildren(...slots.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot-btn';
    b.dataset.slot = s;
    b.setAttribute('aria-pressed', 'false');
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = formatDay(s);
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = formatTime(s);
    b.append(d, t);
    return b;
  }));

  $('#setup-options').replaceChildren(...SETUP_OPTIONS.map((o) => {
    const label = document.createElement('label');
    label.className = 'radio-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'setup';
    input.value = o.id;
    label.append(input, o.label);
    return label;
  }));
}

function updateSlotCount() {
  const n = picked.size;
  $('#slot-count').textContent = `${n} time${n === 1 ? '' : 's'} picked`;
}

function answers() {
  const f = form.elements;
  const file = f.headshot.files && f.headshot.files[0];
  return {
    name: f.name.value.trim(),
    pronouns: f.pronouns.value.trim(),
    email: f.email.value.trim(),
    social: f.social.value.trim(),
    role: f.role.value.trim(),
    topic: f.topic.value.trim(),
    bio: f.bio.value.trim(),
    headshot: file ? file.name : '',
    availability: [...picked].sort(),
    setup: f.setup.value || '',
    notes: f.notes.value.trim(),
    consent: f.consent.checked
  };
}

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
  const keys = Object.keys(errors);
  if (!keys.length) {
    summary.hidden = true;
    summary.replaceChildren();
    return;
  }
  const title = document.createElement('strong');
  title.textContent = keys.length === 1 ? 'Please fix one thing:' : `Please fix ${keys.length} things:`;
  const list = document.createElement('ul');
  for (const key of keys) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#in-${key}`;
    a.textContent = errors[key];
    a.addEventListener('click', (e) => {
      e.preventDefault();
      fields[key].focus();
    });
    li.append(a);
    list.append(li);
  }
  summary.replaceChildren(title, list);
  summary.hidden = false;
  summary.focus();
}

function save(a) {
  const state = loadStoredState() || createInitialState({ timeZone: settings.timeZone, withSamples: false });
  const existing = savedId ? state.guests.find((g) => g.id === savedId) : null;
  let guest = intakeToGuest(a, { id: savedId || undefined });
  if (existing) {
    // Re-submitting after "Edit my answers": update details, keep the host's progress.
    guest = { ...guest, stage: existing.stage, recordingAt: existing.recordingAt, createdAt: existing.createdAt,
      checks: { ...existing.checks, bio: existing.checks.bio || guest.checks.bio, release: existing.checks.release || guest.checks.release } };
  }
  savedId = guest.id;
  return saveState(upsertGuest(state, guest));
}

form.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-slot]');
  if (!btn) return;
  const s = btn.dataset.slot;
  if (picked.has(s)) picked.delete(s);
  else picked.add(s);
  btn.setAttribute('aria-pressed', String(picked.has(s)));
  updateSlotCount();
});

$('#in-headshot').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  $('#headshot-name').textContent = file ? `Selected: ${file.name}` : '';
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const a = answers();
  const errors = validateIntake(a);
  showErrors(errors);
  if (Object.keys(errors).length) return;

  const ok = save(a);
  const text = intakeToText(a, settings);
  $('#intake-text').value = text;
  const n = a.availability.length;
  $('#done-summary').textContent = n
    ? `We’ll confirm one of your ${n} picked time${n === 1 ? '' : 's'} by email, along with the recording guide.`
    : 'We’ll email you to find a recording time, along with the recording guide.';
  $('#email-text').href = buildMailto(settings.hostEmail, `Guest intake: ${a.name}`, text);
  form.hidden = true;
  done.hidden = false;
  $('#done-title').focus();
  if (!ok) toast('This browser blocked saving, so please copy your answers and email them.');
});

$('#edit-answers').addEventListener('click', () => {
  done.hidden = true;
  form.hidden = false;
  $('#in-name').focus();
});

$('#copy-text').addEventListener('click', async () => {
  const text = $('#intake-text').value;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) {
    const ta = $('#intake-text');
    ta.focus();
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  toast(ok ? 'Answers copied. Paste them into an email to the show.' : 'Could not copy automatically. The text is selected: press Ctrl+C or Cmd+C.');
});

// "Read the release" opens the release text.
for (const a of document.querySelectorAll('a[href="#release"]')) {
  a.addEventListener('click', () => { $('#release').open = true; });
}

renderStatic();
updateSlotCount();

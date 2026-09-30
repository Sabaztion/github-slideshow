// Guest availability calendar. Guests paint free half hours on a week grid
// (click, click-and-drag, or keyboard), in the show's time zone or their own.
// Painted cells are kept as UTC instants so both views agree; what is sent
// is host-time slots, the format the rest of the app uses.
import {
  readIntakeParams, isValidTimeZone, validateIntake, formatDay, formatTime, mailtoForText, createInitialState
} from './logic.js';
import {
  weekGrid, weekStartFor, utcToLocal, mergeRanges, formatRange, availabilityToText, MAX_WEEKS_AHEAD
} from './slots.js';
import { buildAvailabilityPayload, validatePayload, applySubmissions, normalizeSubmission, HONEYPOT_FIELD } from './remote.js';
import { postSubmission } from './api.js';
import { inspectStoredState, saveState, browserTimeZone } from './store.js';
import { $, toast, copyTextarea, setBusy, setStatus, hideBackLinkWhenShared, deliveryNote } from './guest-page.js';

const stored = inspectStoredState();
const storedSettings = stored.status === 'ok' ? stored.state.settings : null;
const params = readIntakeParams(window.location.search);
const hostZoneRaw = params.timeZone || storedSettings?.timeZone || browserTimeZone();
const settings = {
  showName: params.showName || storedSettings?.showName || 'the show',
  timeZone: isValidTimeZone(hostZoneRaw) ? hostZoneRaw : 'UTC',
  hostEmail: params.hostEmail || storedSettings?.hostEmail || '',
  endpoint: params.endpoint || storedSettings?.intakeEndpoint || ''
};
const guestZone = browserTimeZone();
const guestToken = params.guestToken || '';

const form = $('#avail-form');
const grid = $('#avail-grid');
const painted = new Set(); // UTC ms of each free half hour
let viewZone = settings.timeZone;
let week = 0;
let focusUtc = null;
let current = null; // the rendered week
let sending = false;
let lastPayload = null;

const zoneLabel = (z) => z.replace(/_/g, ' ');

/* ---------------------------------------------------------------- */
/* Grid                                                              */
/* ---------------------------------------------------------------- */

function renderGrid() {
  const start = weekStartFor(week, viewZone);
  current = weekGrid({ weekStart: start, timeZone: viewZone });
  const cellsFlat = current.days.flatMap((d) => d.cells.filter((c) => c.valid && !c.past));
  if (focusUtc == null || !current.days.some((d) => d.cells.some((c) => c.utc === focusUtc))) {
    focusUtc = cellsFlat.length ? cellsFlat[0].utc : current.days[0].cells[0].utc;
  }

  const thead = grid.tHead;
  const headRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.scope = 'col';
  const cornerText = document.createElement('span');
  cornerText.className = 'sr-only';
  cornerText.textContent = 'Time';
  corner.append(cornerText);
  headRow.append(corner);
  for (const d of current.days) {
    const th = document.createElement('th');
    th.scope = 'col';
    const [wd, md] = formatDay(d.ymd).split(', ');
    const a = document.createElement('span');
    a.className = 'wd';
    a.textContent = wd;
    const b = document.createElement('span');
    b.className = 'md';
    b.textContent = md;
    th.append(a, b);
    headRow.append(th);
  }
  thead.replaceChildren(headRow);

  const rows = current.times.map((t, r) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = t.endsWith(':00') ? formatTime(`2000-01-01T${t}`) : '';
    if (!t.endsWith(':00')) {
      const sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = formatTime(`2000-01-01T${t}`);
      th.append(sr);
    }
    tr.append(th);
    current.days.forEach((d, c) => {
      const cell = d.cells[r];
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      btn.dataset.utc = String(cell.utc);
      btn.dataset.row = String(r);
      btn.dataset.col = String(c);
      const off = cell.past || !cell.valid;
      if (off) btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-pressed', String(painted.has(cell.utc) && !off));
      btn.setAttribute('aria-label', `${formatDay(cell.local)}, ${formatTime(cell.local)}${cell.past ? ' (passed)' : !cell.valid ? ' (not a valid time)' : ''}`);
      btn.tabIndex = cell.utc === focusUtc ? 0 : -1;
      td.append(btn);
      tr.append(td);
    });
    return tr;
  });
  grid.tBodies[0].replaceChildren(...rows);

  $('#week-label').textContent = `${week === 0 ? 'This week' : week === 1 ? 'Next week' : `In ${week} weeks`} · ${formatDay(current.days[0].ymd)} – ${formatDay(current.days[6].ymd)}`;
  $('#grid-caption').textContent = `Free times for the week of ${formatDay(current.days[0].ymd)}, in ${zoneLabel(viewZone)}`;
  $('#week-prev').disabled = week === 0;
  $('#week-next').disabled = week === MAX_WEEKS_AHEAD;
  renderSummary();
}

const cellAt = (r, c) => grid.querySelector(`button.cell[data-row="${r}"][data-col="${c}"]`);
const isOff = (btn) => btn.getAttribute('aria-disabled') === 'true';

function setCell(btn, on) {
  if (!btn || isOff(btn)) return;
  const utc = Number(btn.dataset.utc);
  if (on) painted.add(utc);
  else painted.delete(utc);
  btn.setAttribute('aria-pressed', String(on));
}

function focusCell(btn, { preventScroll = false } = {}) {
  if (!btn) return;
  for (const b of grid.querySelectorAll('button.cell[tabindex="0"]')) b.tabIndex = -1;
  btn.tabIndex = 0;
  focusUtc = Number(btn.dataset.utc);
  btn.focus({ preventScroll });
}

/* Mouse: press and drag to paint. Touch and pen: tap toggles (their "click"). */
let drag = null;
let mouseHandled = false;

grid.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('button.cell');
  mouseHandled = false;
  if (!btn || e.pointerType !== 'mouse' || e.button !== 0) return;
  e.preventDefault(); // no text selection while dragging
  mouseHandled = true;
  if (isOff(btn)) return;
  drag = { on: btn.getAttribute('aria-pressed') !== 'true' };
  setCell(btn, drag.on);
  focusCell(btn, { preventScroll: true }); // scrolling mid-drag would move cells under the pointer
});

grid.addEventListener('pointerover', (e) => {
  if (!drag) return;
  const btn = e.target.closest('button.cell');
  if (btn) setCell(btn, drag.on);
});

window.addEventListener('pointerup', () => {
  if (!drag) return;
  drag = null;
  renderSummary({ announce: true });
});

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('button.cell');
  // A mouse press already painted; keyboard clicks (detail 0) and taps toggle here.
  if (mouseHandled && e.detail > 0) { mouseHandled = false; return; }
  mouseHandled = false;
  if (!btn || isOff(btn)) return;
  setCell(btn, btn.getAttribute('aria-pressed') !== 'true');
  focusCell(btn);
  renderSummary({ announce: true });
});

grid.addEventListener('keydown', (e) => {
  const btn = e.target.closest('button.cell');
  if (!btn) return;
  const r = Number(btn.dataset.row);
  const c = Number(btn.dataset.col);
  const rows = current.times.length;
  const moves = { ArrowUp: [r - 1, c], ArrowDown: [r + 1, c], ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], Home: [r, 0], End: [r, 6], PageUp: [0, c], PageDown: [rows - 1, c] };
  const to = moves[e.key];
  if (!to) return;
  e.preventDefault();
  const [nr, nc] = to;
  if (nr < 0 || nr >= rows || nc < 0 || nc > 6) return;
  focusCell(cellAt(nr, nc));
});

/* ---------------------------------------------------------------- */
/* Summary                                                           */
/* ---------------------------------------------------------------- */

/**
 * Exact instants of the marked half hours. Sent alongside host times so two
 * different instants in a DST fall-back hour stay distinct.
 */
function utcSlots() {
  return [...painted].sort((a, b) => a - b).map((ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`);
}

function hostSlots() {
  return [...painted].sort((a, b) => a - b).map((ms) => utcToLocal(ms, settings.timeZone));
}

function renderSummary({ announce = false } = {}) {
  const inView = [...painted].map((ms) => utcToLocal(ms, viewZone));
  const ranges = mergeRanges(inView);
  const list = $('#range-list');
  if (!ranges.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'Nothing marked yet.';
    list.replaceChildren(li);
  } else {
    list.replaceChildren(...ranges.map((r) => {
      const li = document.createElement('li');
      li.textContent = formatRange(r);
      return li;
    }));
  }
  const visible = new Set(current.days.flatMap((d) => d.cells.map((c) => c.utc)));
  const weekStartMs = current.days[0].cells[0].utc - 12 * 3600000;
  const weekEndMs = current.days[6].cells.at(-1).utc + 12 * 3600000;
  const hiddenThisWeek = [...painted].filter((ms) => ms >= weekStartMs && ms <= weekEndMs && !visible.has(ms)).length;
  $('#summary-hidden').textContent = hiddenThisWeek
    ? `${hiddenThisWeek} marked half hour${hiddenThisWeek === 1 ? ' is' : 's are'} outside the 8 AM – 8 PM rows in this view. Switch time zones to see ${hiddenThisWeek === 1 ? 'it' : 'them'}.`
    : '';
  $('#summary-zone').textContent = `Shown in ${viewZone === guestZone && viewZone !== settings.timeZone ? 'your time zone' : 'the show’s time zone'} (${zoneLabel(viewZone)}).`;
  const n = painted.size;
  $('#slot-count').textContent = `${n} half hour${n === 1 ? '' : 's'} picked`;
  if (announce) setStatus($('#paint-status'), `${n} half hour${n === 1 ? '' : 's'} picked, in ${ranges.length} range${ranges.length === 1 ? '' : 's'}.`);
}

/* ---------------------------------------------------------------- */
/* Controls                                                          */
/* ---------------------------------------------------------------- */

function renderZoneOptions() {
  if (guestZone === settings.timeZone) {
    $('#zone-group').hidden = true;
    $('#zone-same').hidden = false;
    $('#zone-same').textContent = `Times are in ${zoneLabel(settings.timeZone)}, which is also your time zone.`;
    return;
  }
  const opts = [
    { zone: settings.timeZone, label: `The show’s time zone (${zoneLabel(settings.timeZone)})` },
    { zone: guestZone, label: `My time zone (${zoneLabel(guestZone)})` }
  ];
  $('#zone-options').replaceChildren(...opts.map((o) => {
    const label = document.createElement('label');
    label.className = 'radio-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'zone';
    input.value = o.zone;
    input.checked = o.zone === viewZone;
    label.append(input, o.label);
    return label;
  }));
}

$('#zone-options').addEventListener('change', (e) => {
  if (e.target.name !== 'zone') return;
  viewZone = e.target.value;
  renderGrid();
});

$('#week-prev').addEventListener('click', () => { if (week > 0) { week -= 1; renderGrid(); } });
$('#week-next').addEventListener('click', () => { if (week < MAX_WEEKS_AHEAD) { week += 1; renderGrid(); } });
$('#clear-week').addEventListener('click', () => {
  let n = 0;
  for (const d of current.days) for (const c of d.cells) if (painted.delete(c.utc)) n += 1;
  renderGrid();
  toast(n ? `Cleared ${n} half hour${n === 1 ? '' : 's'} this week.` : 'Nothing to clear this week.');
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

/** Save into this browser's guest list, never over unreadable data. */
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
  const ranges = mergeRanges(p.slots);
  $('#done-summary').textContent = `You marked ${ranges.length} time range${ranges.length === 1 ? '' : 's'}. The show will confirm a recording time by email.`;
  $('#done-title').textContent = sent ? 'Thanks, your availability reached the show.' : error ? 'Your availability wasn’t sent yet.' : 'Thanks! Now send your times to the show.';
  $('#fallback-block').hidden = sent;
  const err = $('#send-error');
  err.hidden = !error;
  err.textContent = error ? `Sending failed: ${error} You can try again, or send your times by email instead.` : '';
  $('#retry-send').hidden = !(error && settings.endpoint);
  if (!sent) {
    const text = availabilityToText({ showName: settings.showName, name: p.name, email: p.email, timeZone: settings.timeZone, guestTimeZone: guestZone, slots: p.slots, notes: p.notes });
    $('#avail-text').value = text;
    const mail = mailtoForText(settings.hostEmail, `Availability: ${p.name}`, text);
    $('#email-text').href = mail.href;
    $('#mailto-note').hidden = !mail.truncated;
    const saved = saveLocally(p);
    $('#done-local-note').textContent = `${saved ? 'Your times were saved in this browser’s guest list. ' : ''}Please send them to the show: copy them below, or ${settings.hostEmail ? `open them in your email app (addressed to ${settings.hostEmail})` : 'paste them into an email to the person who invited you'}.`;
  }
  form.hidden = true;
  $('#done').hidden = false;
  $('#done-title').focus();
}

async function send() {
  const status = $('#send-status');
  setStatus(status, 'Sending your availability to the show…');
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
  const f = form.elements;
  const errors = validateIntake({ name: f.name.value, email: f.email.value });
  if (!painted.size) errors.slots = 'Mark at least one half hour when you’re free.';
  showErrors(errors);
  if (Object.keys(errors).length) return;
  lastPayload = buildAvailabilityPayload(
    { name: f.name.value, email: f.email.value, token: guestToken, slots: hostSlots(), slotsUtc: utcSlots(), notes: f.notes.value, guestTimeZone: guestZone },
    { showName: settings.showName, timeZone: settings.timeZone, honeypot: f[HONEYPOT_FIELD]?.value }
  );
  const invalid = validatePayload(lastPayload);
  if (invalid) return showErrors({ slots: invalid });
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
    $('#send-error').textContent = `Sending failed again: ${error} Please send your times by email instead.`;
    btn.focus();
  } else showDone({ sent: true });
});

$('#edit-again').addEventListener('click', () => {
  $('#done').hidden = true;
  form.hidden = false;
  $('#page-title').focus();
});

$('#copy-text').addEventListener('click', async () => {
  const ok = await copyTextarea($('#avail-text'));
  toast(ok ? 'Copied. Paste it into an email to the show.' : 'Could not copy automatically. The text is selected: press Ctrl+C or Cmd+C.');
});

/* ---------------------------------------------------------------- */
/* Start                                                             */
/* ---------------------------------------------------------------- */

hideBackLinkWhenShared();
for (const el of document.querySelectorAll('[data-show-name]')) el.textContent = settings.showName;
document.title = `Availability · ${settings.showName}`;
if (settings.endpoint) $('#delivery-note').textContent = deliveryNote('Your times', settings.showName, settings.endpoint);
$('#hp-field input').name = HONEYPOT_FIELD;
if (params.guestName) form.elements.name.value = params.guestName;
if (params.guestEmail) form.elements.email.value = params.guestEmail;
renderZoneOptions();
renderGrid();

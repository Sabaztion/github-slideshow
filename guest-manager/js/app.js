// Guest manager UI. All pure logic lives in logic.js; this file wires it to the DOM.
import {
  STAGES, CHECKS, PLACEHOLDERS, DEFAULT_TEMPLATES, getStage, nextStage, moveGuest, advanceGuest,
  prepProgress, toggleCheck, initials, displayName, createGuest, updateGuestField, filterGuests,
  sortGuests, formatRecording, formatDay, formatTime, nowInZone, isValidTimeZone, shiftMonth,
  monthLabel, monthGrid, groupByDay, WEEKDAY_NAMES, renderEmail, buildMailto, serializeState,
  parseState, upsertGuest, removeGuest, clearSamples, hasSamples, createInitialState, suggestSlots,
  parseLocal, toLocalString, buildIntakeUrl, countByStage, isValidEmail, softUrlWarning, hasNoRelease, bookSlot
} from './logic.js';
import { loadState, loadStoredState, saveState, browserTimeZone, STORAGE_KEY, unreadableData, releaseUnreadable, loadSync, saveSync } from './store.js';
import { normalizeEndpoint, safeHttpUrl, ensureGuestTokens, endpointHost } from './logic.js';
import { applySubmissions, importSummary, sinceFor, keyUsable, acceptPending, discardPending, describePending } from './remote.js';
import { upcomingRanges, rangesByDay, formatRange } from './slots.js';
import {
  addItem, updateItem, moveItem, removeItem, segmentTimings, formatMinutes, qaStatus, QA_STATUS_LABELS, markQaSent,
  encodeQuestions, promoteAnswer, runSheet, runSheetToText, normalizePlan, normalizeQa, seedQuestions, normalizeQuestionBank, QA_LIMITS
} from './plan.js';
import { checkHealth, fetchSubmissions } from './api.js';

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny element builder. Text is always inserted as text, never as HTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with static icon markup
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

/** replaceChildren that skips null/false (replaceChildren would print "null"). */
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

const ICONS = {
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  prev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  next: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'
};
const icon = (name) => h('span', { html: ICONS[name], style: { display: 'inline-flex' } });

const nowIso = () => new Date().toISOString();
const cssId = (id) => (window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/"/g, '\\"'));
const tz = () => state.settings.timeZone;
const todayYmd = () => nowInZone(tz()).slice(0, 10);

function toast(message) {
  const el = $('#toast');
  el.textContent = '';
  // Re-set on the next frame so screen readers announce repeated messages.
  requestAnimationFrame(() => { el.textContent = message; });
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.textContent = ''; }, 4500);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' }, readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------------------------------------------- */
/* State                                                             */
/* ---------------------------------------------------------------- */

let state = ensureGuestTokens(loadState());
let storageWarned = false;
// Read key, last check time and imported submission ids: kept apart from the
// main data, never exported and never put in a link.
let sync = loadSync();

const ui = {
  view: 'pipeline',
  query: '',
  selectedId: null,
  sort: { key: 'recording', dir: 'asc' },
  cal: null,
  templateId: DEFAULT_TEMPLATES[0].id,
  panelTemplateId: DEFAULT_TEMPLATES[0].id,
  previewGuestId: null,
  tplLastField: 'body',
  dragId: null
};

function commit(next, { main = true } = {}) {
  state = ensureGuestTokens(next);
  if (!saveState(state) && !storageWarned && !unreadableData()) {
    storageWarned = true;
    toast('Browser storage is unavailable, so changes will be lost when you close this tab. Use Export to keep a copy.');
  }
  renderChrome();
  if (main) renderMain();
}

const findGuest = (id) => state.guests.find((g) => g.id === id) || null;

function saveGuest(guest, opts) {
  commit(upsertGuest(state, guest), opts);
}

/* ---------------------------------------------------------------- */
/* Elements                                                          */
/* ---------------------------------------------------------------- */

const app = $('#app');
const nav = $('.sidebar');
const main = $('#main');
const panel = $('#panel');
const backdrop = $('#panel-backdrop');
const board = $('#board');
const search = $('#guest-search');
const addDialog = $('#add-dialog');
const addForm = $('#add-form');
const overlayQuery = window.matchMedia('(max-width: 1179px)');

const VIEWS = {
  pipeline: { title: 'Guest pipeline', sub: () => 'Everyone from first pitch to published episode.', search: true },
  calendar: { title: 'Recording calendar', sub: () => `Recordings by month, shown in ${tz()}.`, search: false },
  guests: { title: 'All guests', sub: () => 'Every guest in one sortable list.', search: true },
  templates: { title: 'Email templates', sub: () => 'Write each email once. Placeholders fill in per guest.', search: false },
  settings: { title: 'Settings', sub: () => 'Show details, the guest intake form and backups.', search: false },
  plans: { title: 'Episode plans', sub: () => 'Every guest’s episode plan and pre-interview Q&A.', search: true },
  plan: { title: 'Episode plan', sub: () => { const g = findGuest(ui.planGuestId); return g ? `For ${displayName(g)}: talking points, on-air questions and the guest’s Q&A.` : ''; }, search: false }
};

/* ---------------------------------------------------------------- */
/* Chrome + routing                                                  */
/* ---------------------------------------------------------------- */

function renderChrome() {
  $('#brand-name').textContent = state.settings.showName;
  $('#sample-banner').hidden = !hasSamples(state);
  const bad = unreadableData();
  $('#corrupt-banner').hidden = !bad;
  if (bad) {
    $('#corrupt-detail').textContent = bad.backupKey
      ? `A copy was kept under the storage key “${bad.backupKey}”. (${bad.error})`
      : `It could not be copied to a backup key, so it has been left exactly as it was. (${bad.error})`;
  }
}

function downloadRaw() {
  const bad = unreadableData();
  if (!bad) return;
  download(`guest-manager-unreadable-${todayYmd()}.json`, bad.raw);
  toast('Downloaded the stored data exactly as it was.');
}

function startFreshFromUnreadable() {
  const bad = unreadableData();
  if (!bad) return;
  const where = bad.backupKey ? `It stays backed up under “${bad.backupKey}”.` : 'It could NOT be backed up, so download it first if you need it.';
  if (!window.confirm(`Start saving again? The unreadable data will be replaced by what you see now. ${where}`)) return;
  releaseUnreadable();
  commit(state);
  toast('Saving is back on.');
}

function setView(route, { focus = false } = {}) {
  // Routes: "#pipeline", "#calendar", … and "#plan/<guest id>".
  let [view, arg] = String(route || '').split('/');
  if (view === 'plan') {
    try {
      ui.planGuestId = decodeURIComponent(arg || '');
    } catch {
      ui.planGuestId = ''; // a malformed link like #plan/%E0 falls back to the pipeline
    }
    if (!findGuest(ui.planGuestId)) view = 'pipeline';
    else if (ui.selectedId) closePanel({ restore: false }); // the plan needs the room
  }
  if (!VIEWS[view]) view = 'pipeline';
  ui.view = view;
  const meta = VIEWS[view];
  for (const link of nav.querySelectorAll('[data-view]')) {
    // A single plan counts as being inside "Episode plans".
    if (link.dataset.view === view || (view === 'plan' && link.dataset.view === 'plans')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const key of Object.keys(VIEWS)) $(`#view-${key}`).hidden = key !== view;
  $('#view-title').textContent = meta.title;
  $('#view-sub').textContent = meta.sub();
  $('#search-wrap').hidden = !meta.search;
  main.classList.toggle('is-board', view === 'pipeline');
  document.title = `${meta.title} · ${state.settings.showName} · Guest Manager`;
  renderMain();
  if (focus) {
    const title = $('#view-title');
    title.tabIndex = -1;
    title.focus();
  }
}

function renderMain() {
  $('#view-sub').textContent = VIEWS[ui.view].sub();
  if (ui.view === 'pipeline') renderPipeline();
  else if (ui.view === 'calendar') renderCalendar();
  else if (ui.view === 'guests') renderGuests();
  else if (ui.view === 'templates') renderTemplates();
  else if (ui.view === 'settings') renderSettings();
  else if (ui.view === 'plan') renderPlan();
  else if (ui.view === 'plans') renderPlans();
}

/* ---------------------------------------------------------------- */
/* Pipeline                                                          */
/* ---------------------------------------------------------------- */

function cardWhen(g) {
  if (g.recordingAt) return formatRecording(g.recordingAt);
  return g.stage === 'outreach' ? 'Not scheduled' : 'No date set';
}

function stagePill(stageId, extra) {
  const s = getStage(stageId);
  return h('span', { class: 'pill', style: { background: s.bg, color: s.fg } }, s.label, extra);
}

function sampleTag() {
  return h('span', { class: 'tag-sample', title: 'Sample guest' }, 'Sample');
}

/** Shown when a guest submitted the intake form without agreeing to the release. */
function noReleaseTag() {
  return h('span', { class: 'tag-warn', title: 'The guest did not agree to the recording release on the intake form' }, 'No release');
}

function guestCard(g) {
  const p = prepProgress(g);
  const next = nextStage(g.stage);
  const selected = g.id === ui.selectedId;
  return h('li', { class: `card${selected ? ' selected' : ''}`, draggable: 'true', dataset: { id: g.id } },
    h('button', { type: 'button', class: 'card-open', dataset: { openGuest: g.id }, 'aria-expanded': String(selected), 'aria-controls': 'panel' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(g.name)),
      h('span', { class: 'card-who' },
        h('span', { class: 'card-name' }, displayName(g)),
        g.role || g.sample ? h('span', { class: 'card-role' }, g.sample ? [sampleTag(), ' '] : null, g.role) : null
      )
    ),
    g.topic ? h('p', { class: 'card-topic' }, g.topic) : null,
    hasNoRelease(g) || qaStatus(g) !== 'not-sent' ? h('p', { class: 'card-flags' }, hasNoRelease(g) ? noReleaseTag() : null, qaStatus(g) !== 'not-sent' ? h('span', { class: `qa-chip qa-${qaStatus(g)}` }, QA_STATUS_LABELS[qaStatus(g)]) : null) : null,
    h('div', { class: 'card-meta' },
      h('span', null, cardWhen(g)),
      h('span', null, `${p.done}/${p.total} prep`)
    ),
    h('span', { class: `bar${p.complete ? ' complete' : ''}`, 'aria-hidden': 'true' }, h('span', { style: { width: `${p.pct}%` } })),
    next ? h('button', { type: 'button', class: 'card-move', dataset: { move: g.id }, 'aria-label': `Move ${displayName(g)} to ${next.label}` }, `Move to ${next.label} →`) : null
  );
}

function renderPipeline() {
  const visible = sortGuests(filterGuests(state.guests, ui.query), 'recording');
  const counts = countByStage(visible);
  board.replaceChildren(...STAGES.map((stage) => {
    const cards = visible.filter((g) => g.stage === stage.id);
    return h('section', { class: 'column', dataset: { stage: stage.id }, 'aria-labelledby': `col-${stage.id}` },
      h('h2', { class: 'col-head', id: `col-${stage.id}` },
        h('span', null, h('span', { class: 'dot', style: { background: stage.dot }, 'aria-hidden': 'true' }), stage.label),
        h('span', { class: 'col-count' }, h('span', { class: 'sr-only' }, ', '), String(counts[stage.id]), h('span', { class: 'sr-only' }, counts[stage.id] === 1 ? ' guest' : ' guests'))
      ),
      h('ol', { class: 'col-list' },
        cards.length ? cards.map(guestCard) : h('li', { class: 'empty-col' }, ui.query ? 'No matches' : 'No guests here')
      )
    );
  }));
}

function moveTo(id, stageId, { focusMoved = false } = {}) {
  const g = findGuest(id);
  if (!g || g.stage === stageId) return;
  saveGuest(moveGuest(g, stageId, nowIso()));
  if (ui.selectedId === id) renderPanel();
  toast(`Moved ${displayName(g)} to ${getStage(stageId).label}.`);
  if (focusMoved) {
    const card = board.querySelector(`.card[data-id="${cssId(id)}"]`);
    const target = card && (card.querySelector('.card-move') || card.querySelector('.card-open'));
    if (target) {
      target.focus();
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

function initBoard() {
  board.addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    if (move) {
      const g = findGuest(move.dataset.move);
      const next = g && nextStage(g.stage);
      if (next) moveTo(g.id, next.id, { focusMoved: true });
      return;
    }
    const open = e.target.closest('[data-open-guest]');
    if (open) return openGuest(open.dataset.openGuest);
    const card = e.target.closest('.card');
    if (card && !e.target.closest('button, a, input')) openGuest(card.dataset.id);
  });

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    ui.dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  board.addEventListener('dragend', () => {
    ui.dragId = null;
    board.querySelectorAll('.dragging, .drop-target').forEach((el) => el.classList.remove('dragging', 'drop-target'));
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.column');
    if (!col || !ui.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    board.querySelectorAll('.drop-target').forEach((el) => el !== col && el.classList.remove('drop-target'));
    col.classList.add('drop-target');
  });
  board.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.column');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop-target');
  });
  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.column');
    if (!col) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || ui.dragId;
    col.classList.remove('drop-target');
    ui.dragId = null;
    if (id) moveTo(id, col.dataset.stage);
  });
}

/* ---------------------------------------------------------------- */
/* Guest detail panel                                                */
/* ---------------------------------------------------------------- */

const PANEL_FIELDS = [
  { key: 'name', label: 'Full name', span: true },
  { key: 'pronouns', label: 'Pronouns' },
  { key: 'role', label: 'Role or title' },
  { key: 'topic', label: 'Topic', span: true, rows: 2 },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'social', label: 'Website or social' },
  { key: 'recordingAt', label: 'Recording date & time', type: 'datetime-local', span: true, hint: () => `(${tz()})` },
  { key: 'episode', label: 'Episode no.', inputmode: 'numeric' },
  { key: 'episodeLink', label: 'Episode link', type: 'url' },
  { key: 'bio', label: 'Bio', span: true, rows: 3 }
];

function fieldControl(g, f) {
  const id = `f-${f.key}`;
  const control = f.rows
    ? h('textarea', { id, rows: f.rows, dataset: { field: f.key } })
    : h('input', { id, type: f.type || 'text', inputmode: f.inputmode, dataset: { field: f.key }, autocomplete: 'off' });
  control.value = g[f.key] || '';
  return h('label', { class: `field${f.span ? ' span-2' : ''}` }, h('span', null, f.label, f.hint ? h('span', { class: 'hint' }, ` ${f.hint()}`) : null), control);
}

/**
 * Submissions that matched this guest only by email or id. Anyone who knows
 * an email address could have sent them, so the host decides.
 */
function pendingSection(g) {
  if (!g.pending.length) return null;
  return h('section', { class: 'panel-section pending', 'aria-labelledby': 'h-pending' },
    h('h3', { class: 'section-label', id: 'h-pending' }, `Needs review (${g.pending.length})`),
    h('p', { class: 'hint', style: { margin: 0, fontSize: '13px' } }, 'These came in without this guest’s personal link, so they only match by email or id. Accept to merge them, or discard them.'),
    h('ul', { class: 'range-book' }, g.pending.map((p, i) => h('li', null,
      h('span', { class: 'range-label', id: `pend-${i}` }, describePending(p)),
      h('div', { class: 'range-actions' },
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', dataset: { action: 'accept-pending', sub: p.id }, 'aria-describedby': `pend-${i}` }, 'Accept'),
        h('button', { type: 'button', class: 'btn btn-quiet btn-sm', dataset: { action: 'discard-pending', sub: p.id }, 'aria-describedby': `pend-${i}` }, 'Discard')
      )
    )))
  );
}

/**
 * Times the guest marked on the availability calendar, merged into ranges.
 * Each range can be booked at any of its half-hour starts.
 */
function freeTimesSection(g) {
  const ranges = upcomingRanges(g.freeSlots, nowInZone(tz()));
  return h('section', { class: 'panel-section', 'aria-labelledby': 'h-free' },
    h('div', { class: 'panel-section-head' },
      h('h3', { class: 'section-label', id: 'h-free' }, 'Availability calendar'),
      g.freeSlots.length ? h('span', { class: 'mono' }, `${ranges.length} range${ranges.length === 1 ? '' : 's'}`) : null
    ),
    ranges.length
      ? h('ul', { class: 'range-book' }, ranges.map((r, i) => {
        const id = `free-${i}`;
        return h('li', null,
          h('span', { class: 'range-label', id: `${id}-label` }, formatRange(r)),
          h('div', { class: 'range-actions' },
            r.slots.length > 1
              ? h('label', null, h('span', { class: 'sr-only' }, `Start time for ${formatRange(r)}`),
                h('select', { id: `${id}-start`, class: 'range-start' }, r.slots.map((s) => h('option', { value: s, selected: s === g.recordingAt }, formatTime(s)))))
              : null,
            h('button', { type: 'button', class: 'btn btn-quiet btn-sm', dataset: { action: 'book-range', range: String(i), first: r.slots[0] }, 'aria-label': `${g.recordingAt && r.slots.includes(g.recordingAt) ? 'Change booking in' : 'Book'} ${formatRange(r)}` },
              g.recordingAt && r.slots.includes(g.recordingAt) ? 'Booked · change' : 'Book')
          )
        );
      }))
      : h('p', { class: 'hint', style: { margin: 0, fontSize: '13px' } }, g.freeSlots.length ? 'The times this guest marked have passed.' : 'No calendar times yet. Send the guest your availability link.'),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-outline btn-sm', dataset: { action: 'copy-availability' } }, 'Copy availability link'),
      h('a', { class: 'btn btn-quiet btn-sm', id: 'panel-avail-mail', href: templateMailto(g, 'availability') }, 'Email availability request')
    )
  );
}

/** mailto: for one of the templates, filled in for this guest. */
function templateMailto(g, templateId) {
  const tpl = state.templates.find((t) => t.id === templateId);
  if (!tpl) return buildMailto(g.email);
  const mail = renderEmail(tpl, g, state.settings, guestLinks(g));
  return buildMailto(g.email, mail.subject, mail.body);
}

function panelEmail(g) {
  const tpl = state.templates.find((t) => t.id === ui.panelTemplateId) || state.templates[0];
  const email = renderEmail(tpl, g, state.settings, guestLinks(g));
  return { tpl, ...email, href: buildMailto(g.email, email.subject, email.body) };
}

function renderPanel() {
  const g = findGuest(ui.selectedId);
  if (!g) return closePanel({ restore: false });

  // Keep focus, caret and scroll position across re-renders.
  const active = document.activeElement;
  const activeId = active && panel.contains(active) ? active.id : '';
  const caret = activeId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scrollTop = $('.panel-scroll', panel)?.scrollTop || 0;

  const stage = getStage(g.stage);
  const next = nextStage(g.stage);
  const p = prepProgress(g);
  const mail = panelEmail(g);
  const sub = [g.role, g.pronouns].filter(Boolean).join(' · ');

  panel.replaceChildren(
    h('div', { class: 'panel-scroll' },
      h('div', { class: 'panel-top' },
        h('button', { type: 'button', class: 'btn btn-icon', dataset: { action: 'close-panel' }, 'aria-label': 'Close guest details', title: 'Close (Esc)' }, icon('close'))
      ),
      h('div', { class: 'panel-head' },
        h('span', { class: 'panel-avatar', id: 'panel-initials', 'aria-hidden': 'true' }, initials(g.name)),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '0' } },
          h('h2', { id: 'panel-name', tabindex: '-1' }, displayName(g)),
          h('span', { class: 'panel-sub', id: 'panel-sub' }, sub)
        )
      ),
      h('div', { class: 'stage-row' },
        h('span', { class: 'pill', id: 'panel-pill', style: { background: stage.bg, color: stage.fg } }, stage.label),
        h('label', { class: 'field' }, h('span', { class: 'sr-only' }, 'Stage'),
          h('select', { id: 'panel-stage', 'aria-label': 'Stage' }, STAGES.map((s) => h('option', { value: s.id, selected: s.id === g.stage }, s.label)))
        ),
        g.sample ? sampleTag() : null,
        hasNoRelease(g) ? noReleaseTag() : null
      ),

      h('section', { class: 'panel-section', 'aria-labelledby': 'h-details' },
        h('h3', { class: 'section-label', id: 'h-details' }, 'Details'),
        h('div', { class: 'field-grid' }, PANEL_FIELDS.map((f) => fieldControl(g, f))),
        safeHttpUrl(g.headshot)
          ? h('p', { class: 'panel-note' }, 'Headshot: ', h('a', { href: safeHttpUrl(g.headshot), target: '_blank', rel: 'noopener noreferrer' }, 'Open photo ↗'))
          : g.headshot ? h('p', { class: 'panel-note hint' }, `Headshot file named “${g.headshot}” (not uploaded).`) : null
      ),

      pendingSection(g),

      freeTimesSection(g),

      g.availability.length ? h('section', { class: 'panel-section', 'aria-labelledby': 'h-avail' },
        h('h3', { class: 'section-label', id: 'h-avail' }, 'Times the guest offered'),
        h('ul', { class: 'slot-list' }, g.availability.map((s) =>
          h('li', null,
            h('span', null, `${formatDay(s)} · ${formatTime(s)}`),
            g.recordingAt === s
              ? h('span', { class: 'hint' }, 'Booked')
              : h('button', { type: 'button', class: 'btn btn-quiet btn-sm', dataset: { action: 'book-slot', slot: s }, 'aria-label': `Book ${formatDay(s)} at ${formatTime(s)}` }, 'Book this time')
          )
        ))
      ) : null,

      h('section', { class: 'panel-section', 'aria-labelledby': 'h-prep' },
        h('div', { class: 'panel-section-head' },
          h('h3', { class: 'section-label', id: 'h-prep' }, 'Prep checklist'),
          h('span', { class: 'mono' }, `${p.done} of ${p.total}`)
        ),
        CHECKS.map((c) => h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', id: `chk-${c.key}`, checked: g.checks[c.key], dataset: { check: c.key } }),
          h('span', null, c.label)
        ))
      ),

      h('section', { class: 'panel-section', 'aria-labelledby': 'h-notes' },
        h('h3', { class: 'section-label', id: 'h-notes' }, h('label', { for: 'f-notes' }, 'Notes')),
        (() => { const t = h('textarea', { id: 'f-notes', class: 'input', rows: 4, dataset: { field: 'notes' } }); t.value = g.notes; return t; })()
      ),

      h('section', { class: 'panel-section', 'aria-labelledby': 'h-email' },
        h('h3', { class: 'section-label', id: 'h-email' }, 'Email from a template'),
        h('label', { class: 'field' }, 'Template',
          h('select', { id: 'panel-tpl' }, state.templates.map((t) => h('option', { value: t.id, selected: t.id === mail.tpl.id }, t.name)))
        ),
        h('div', { class: 'email-preview', id: 'panel-email-preview', tabindex: '0', 'aria-label': 'Email preview' },
          h('strong', null, mail.subject), mail.body
        ),
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn btn-outline', id: 'panel-mailto', href: mail.href }, 'Open in email app'),
          h('button', { type: 'button', class: 'btn btn-quiet', id: 'panel-copy', dataset: { action: 'copy-email' } }, 'Copy email')
        ),
        g.email ? null : h('p', { class: 'hint', style: { margin: 0, fontSize: '13px' } }, 'No email address yet, so your mail app will ask who to send it to.')
      ),

      h('section', { class: 'panel-section', 'aria-labelledby': 'h-plan' },
        h('div', { class: 'panel-section-head' },
          h('h3', { class: 'section-label', id: 'h-plan' }, 'Episode plan & Q&A'),
          h('span', { class: `qa-chip qa-${qaStatus(g)}` }, QA_STATUS_LABELS[qaStatus(g)])
        ),
        h('a', { class: 'btn btn-outline', href: `#plan/${encodeURIComponent(g.id)}` }, 'Open episode plan')
      ),

      h('section', { class: 'panel-section', 'aria-labelledby': 'h-danger' },
        h('h3', { class: 'section-label', id: 'h-danger' }, 'Remove'),
        h('button', { type: 'button', class: 'btn btn-danger', id: 'panel-delete', dataset: { action: 'delete-guest' } }, `Delete ${displayName(g)}`)
      )
    ),
    panelFoot(g)
  );

  $('.panel-scroll', panel).scrollTop = scrollTop;
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.focus({ preventScroll: true });
      if (caret && typeof el.setSelectionRange === 'function') try { el.setSelectionRange(...caret); } catch { /* not a text input */ }
    }
  }
}

function panelFoot(g) {
  const next = nextStage(g.stage);
  return h('div', { class: 'panel-foot' },
    g.email
      ? h('a', { class: 'btn btn-outline', href: buildMailto(g.email) }, 'Email guest')
      : h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'focus-email' } }, 'Add email'),
    next
      ? h('button', { type: 'button', class: 'btn btn-primary', id: 'panel-advance', dataset: { action: 'advance' } }, `Move to ${next.label}`)
      : h('span', { class: 'btn', style: { cursor: 'default', color: getStage('published').fg } }, 'Published ✓')
  );
}

/** Update only the stage-dependent parts of the panel (pill, picker, footer). */
function refreshPanelStage(g) {
  const s = getStage(g.stage);
  const pill = $('#panel-pill');
  if (pill) {
    pill.textContent = s.label;
    pill.style.background = s.bg;
    pill.style.color = s.fg;
  }
  const sel = $('#panel-stage');
  if (sel && sel.value !== g.stage) sel.value = g.stage;
  $('.panel-foot', panel)?.replaceWith(panelFoot(g));
}

/** Light update while typing in the panel (no full re-render, so typing is never interrupted). */
function refreshPanelSummary(g) {
  $('#panel-name').textContent = displayName(g);
  $('#panel-initials').textContent = initials(g.name);
  $('#panel-sub').textContent = [g.role, g.pronouns].filter(Boolean).join(' · ');
  $('#panel-delete').textContent = `Delete ${displayName(g)}`;
  const mail = panelEmail(g);
  $('#panel-email-preview').replaceChildren(h('strong', null, mail.subject), mail.body);
  $('#panel-mailto').href = mail.href;
}

function syncOverlay() {
  const overlay = overlayQuery.matches && !panel.hidden;
  backdrop.hidden = !overlay;
  nav.inert = overlay;
  main.inert = overlay;
  // The skip link lives outside #app, so it must go inert with the rest of the page.
  const skip = $('.skip-link');
  if (skip) skip.inert = overlay;
  document.body.classList.toggle('panel-overlay', overlay);
  // As a slide-over sheet the panel is a modal dialog; announce it as one.
  if (overlay) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'panel-name');
    panel.removeAttribute('aria-label');
  } else {
    panel.setAttribute('role', 'region');
    panel.removeAttribute('aria-modal');
    panel.removeAttribute('aria-labelledby');
    panel.setAttribute('aria-label', 'Guest details');
  }
}

function openGuest(id) {
  if (!findGuest(id)) return;
  // Remember the control that opened the panel, to return focus there on close.
  const active = document.activeElement;
  if (active && active !== document.body && !panel.contains(active)) ui.opener = active;
  ui.selectedId = id;
  panel.hidden = false;
  app.classList.add('panel-open');
  renderPanel();
  renderMain();
  syncOverlay();
  $('#panel-name').focus();
}

function closePanel({ restore = true } = {}) {
  const id = ui.selectedId;
  ui.selectedId = null;
  panel.hidden = true;
  panel.replaceChildren();
  app.classList.remove('panel-open');
  syncOverlay();
  renderMain();
  const opener = ui.opener;
  ui.opener = null;
  if (restore && id) {
    if (opener && opener.isConnected && !opener.closest('[hidden]')) return opener.focus();
    const view = $(`#view-${ui.view}`);
    const target = view.querySelector(`[data-open-guest="${cssId(id)}"]`);
    (target || $('#view-title')).focus();
  }
}

/**
 * Apply a stage picked with the keyboard. On Enter the panel re-renders and
 * focus returns to the picker. On blur only the stage-dependent parts are
 * updated, so the focus move (Tab, Shift+Tab, a click on Close) goes ahead.
 */
function commitPendingStage({ refocus = true } = {}) {
  const g = findGuest(ui.selectedId);
  const value = ui.stagePending;
  ui.stagePending = null;
  if (!g || !value || value === g.stage) return;
  if (refocus) {
    moveTo(g.id, value);
    $('#panel-stage')?.focus();
    return;
  }
  const moved = moveGuest(g, value, nowIso());
  saveGuest(moved);
  refreshPanelStage(moved);
  toast(`Moved ${displayName(g)} to ${getStage(value).label}.`);
}

/** Non-blocking hint under a panel field whose value looks wrong. */
function checkPanelField(input) {
  const key = input.dataset.field;
  let msg = '';
  if (key === 'email' && input.value.trim() && !isValidEmail(input.value)) msg = 'This doesn’t look like an email address (name@example.com).';
  if (key === 'episodeLink') msg = softUrlWarning(input.value);
  if (key === 'social') msg = softUrlWarning(input.value, { allowHandle: true });
  if (!['email', 'episodeLink', 'social'].includes(key)) return;
  const id = `${input.id}-warn`;
  let out = document.getElementById(id);
  if (!msg) {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    out?.remove();
    return;
  }
  if (!out) {
    out = h('span', { class: 'field-error', id });
    input.insertAdjacentElement('afterend', out);
  }
  out.textContent = msg;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', id);
}

function initPanel() {
  panel.addEventListener('input', (e) => {
    const field = e.target.dataset.field;
    const g = findGuest(ui.selectedId);
    if (!field || !g) return;
    const updated = updateGuestField(g, field, e.target.value, nowIso());
    saveGuest(updated);
    refreshPanelSummary(updated);
  });

  panel.addEventListener('change', (e) => {
    const g = findGuest(ui.selectedId);
    if (!g) return;
    if (e.target.id === 'panel-stage') {
      // Arrow keys on a closed select fire "change" on every step. After a
      // keyboard change, wait for Enter or leaving the field before moving.
      if (ui.stageKeyed) { ui.stagePending = e.target.value; return; }
      moveTo(g.id, e.target.value);
    } else if (e.target.dataset.check) {
      saveGuest(toggleCheck(g, e.target.dataset.check, nowIso()));
      renderPanel();
    } else if (e.target.id === 'panel-tpl') {
      ui.panelTemplateId = e.target.value;
      refreshPanelSummary(g);
    } else if (e.target.dataset.field === 'recordingAt') {
      renderPanel(); // update "Booked" markers on offered times
    }
  });

  panel.addEventListener('click', (e) => {
    // Sending the Pre-interview questions template from the panel counts as sending the Q&A.
    if (e.target.closest('#panel-mailto') && ui.panelTemplateId === 'qa') {
      const g = findGuest(ui.selectedId);
      if (g) prepareQa(g);
    }
  });
  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const g = findGuest(ui.selectedId);
    const action = btn.dataset.action;
    if (action === 'close-panel') return closePanel();
    if (!g) return;
    if (action === 'advance') {
      const next = nextStage(g.stage);
      saveGuest(advanceGuest(g, nowIso()));
      renderPanel();
      toast(`Moved ${displayName(g)} to ${next.label}.`);
      ($('#panel-advance') || $('#panel-stage')).focus();
    } else if (action === 'copy-email') {
      const mail = panelEmail(g);
      const ok = await copyText(`To: ${g.email}\nSubject: ${mail.subject}\n\n${mail.body}`);
      toast(ok ? 'Email copied to the clipboard.' : 'Could not copy. Select the preview text and copy it yourself.');
    } else if (action === 'delete-guest') {
      if (!window.confirm(`Delete ${displayName(g)}? This cannot be undone.`)) return;
      commit(removeGuest(state, g.id));
      closePanel({ restore: false });
      $('#view-title').focus();
      toast(`Deleted ${displayName(g)}.`);
    } else if (action === 'accept-pending' || action === 'discard-pending') {
      const updated = action === 'accept-pending'
        ? acceptPending(g, btn.dataset.sub, { nowIso: nowIso(), hostTimeZone: tz() })
        : discardPending(g, btn.dataset.sub);
      saveGuest(updated);
      renderPanel();
      ($('[data-action="accept-pending"]', panel) || $('#panel-name')).focus();
      toast(action === 'accept-pending' ? 'Merged into this guest.' : 'Discarded.');
    } else if (action === 'book-range') {
      const sel = $(`#free-${btn.dataset.range}-start`);
      const slot = sel ? sel.value : btn.dataset.first;
      saveGuest(bookSlot(g, slot, nowIso()));
      renderPanel();
      $('#f-recordingAt').focus();
      toast(`Booked ${displayName(g)} for ${formatRecording(slot)}.`);
    } else if (action === 'copy-availability') {
      toast((await copyText(availabilityUrl(g))) ? `Availability link for ${displayName(g)} copied.` : 'Could not copy the link.');
    } else if (action === 'book-slot') {
      let updated = updateGuestField(g, 'recordingAt', btn.dataset.slot, nowIso());
      if (updated.stage === 'outreach') updated = moveGuest(updated, 'booked', nowIso());
      saveGuest(updated);
      renderPanel();
      $('#f-recordingAt').focus();
      toast(`Booked ${displayName(g)} for ${formatRecording(btn.dataset.slot)}.`);
    } else if (action === 'focus-email') {
      $('#f-email').focus();
    }
  });

  panel.addEventListener('keydown', (e) => {
    if (e.target.id !== 'panel-stage') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitPendingStage();
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key) || e.key.length === 1) {
      ui.stageKeyed = true;
    }
  });
  panel.addEventListener('pointerdown', (e) => {
    if (e.target.id === 'panel-stage') ui.stageKeyed = false;
  });
  panel.addEventListener('focusout', (e) => {
    if (e.target.id === 'panel-stage') {
      commitPendingStage({ refocus: false });
      ui.stageKeyed = false;
    }
    // Soft checks on email and link fields once the person leaves them.
    if (e.target.dataset?.field) checkPanelField(e.target);
  });

  backdrop.addEventListener('click', () => closePanel());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden && !addDialog.open) {
      e.preventDefault();
      // Escape on the stage picker with an uncommitted keyboard change cancels the change first.
      if (e.target.id === 'panel-stage' && ui.stagePending) {
        ui.stagePending = null;
        ui.stageKeyed = false;
        e.target.value = findGuest(ui.selectedId)?.stage || e.target.value;
        return;
      }
      closePanel();
    }
  });
  overlayQuery.addEventListener('change', syncOverlay);
}

/* ---------------------------------------------------------------- */
/* All guests table                                                  */
/* ---------------------------------------------------------------- */

const TABLE_COLS = [
  { key: 'name', label: 'Name', sort: 'name' },
  { key: 'stage', label: 'Stage', sort: 'stage' },
  { key: 'role', label: 'Role' },
  { key: 'topic', label: 'Topic' },
  { key: 'recording', label: 'Recording', sort: 'recording' },
  { key: 'prep', label: 'Prep' },
  { key: 'episode', label: 'Ep.' }
];

function renderGuests() {
  const view = $('#view-guests');
  const list = sortGuests(filterGuests(state.guests, ui.query), ui.sort.key, ui.sort.dir);
  const active = TABLE_COLS.find((c) => c.sort === ui.sort.key);
  const dirWord = ui.sort.dir === 'asc' ? 'ascending' : 'descending';

  const head = h('tr', null, TABLE_COLS.map((c) => {
    if (!c.sort) return h('th', { scope: 'col' }, c.label);
    const on = c.sort === ui.sort.key;
    return h('th', { scope: 'col', 'aria-sort': on ? dirWord : null },
      h('button', { type: 'button', class: 'sort-btn', id: `sort-${c.sort}`, dataset: { sort: c.sort } },
        c.label,
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, on ? (ui.sort.dir === 'asc' ? '↑' : '↓') : '↕'),
        h('span', { class: 'sr-only' }, on ? `, sorted ${dirWord}` : ', sortable')
      )
    );
  }));

  const rows = list.map((g) => {
    const p = prepProgress(g);
    return h('tr', null,
      h('td', null,
        h('button', { type: 'button', class: 'name-btn', dataset: { openGuest: g.id } },
          h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(g.name)),
          h('span', { class: 'nm' }, displayName(g))
        ),
        g.sample ? [' ', sampleTag()] : null
      ),
      h('td', null, stagePill(g.stage)),
      h('td', { class: 'cell-muted' }, g.role),
      h('td', { class: 'cell-muted' }, g.topic),
      h('td', { class: 'cell-mono' }, g.recordingAt ? formatRecording(g.recordingAt) : '—'),
      h('td', { class: 'cell-mono' }, `${p.done}/${p.total}`),
      h('td', { class: 'cell-mono' }, g.episode || '—')
    );
  });

  view.replaceChildren(
    h('div', { class: 'table-wrap' },
      h('table', { class: 'guest-table' },
        h('caption', { class: 'sr-only' }, `All guests, ${list.length} shown, sorted by ${active.label.toLowerCase()} ${dirWord}.`),
        h('thead', null, head),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: TABLE_COLS.length, class: 'table-empty' }, ui.query ? `No guests match “${ui.query}”.` : 'No guests yet. Use “Add guest” to start.')))
      )
    )
  );
}

function initGuests() {
  $('#view-guests').addEventListener('click', (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const key = sortBtn.dataset.sort;
      ui.sort = ui.sort.key === key ? { key, dir: ui.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
      renderGuests();
      $(`#sort-${key}`).focus();
      return;
    }
    const open = e.target.closest('[data-open-guest]');
    if (open) openGuest(open.dataset.openGuest);
  });
}

/* ---------------------------------------------------------------- */
/* Calendar                                                          */
/* ---------------------------------------------------------------- */

function renderCalendar() {
  const view = $('#view-calendar');
  if (!ui.cal) {
    const t = parseLocal(todayYmd());
    ui.cal = { year: t.y, month: t.m };
  }
  const { year, month } = ui.cal;
  const today = todayYmd();
  const groups = groupByDay(state.guests);
  const weeks = monthGrid(year, month, 0);
  const inMonthCount = weeks.flat().filter((c) => c.inMonth && groups[c.ymd]).reduce((n, c) => n + groups[c.ymd].length, 0);
  const unscheduled = sortGuests(state.guests.filter((g) => g.stage === 'booked' && !g.recordingAt), 'name');
  // Optional overlay: one guest's free times from the availability calendar.
  const withFree = sortGuests(state.guests.filter((g) => g.freeSlots.length), 'name');
  if (ui.calAvail === undefined && findGuest(ui.selectedId)?.freeSlots.length) ui.calAvail = ui.selectedId;
  const overlayGuest = withFree.find((g) => g.id === ui.calAvail) || null;
  const free = overlayGuest ? rangesByDay(overlayGuest.freeSlots) : {};

  const cell = (c) => {
    const events = groups[c.ymd] || [];
    const frees = free[c.ymd] || [];
    const cls = [c.inMonth ? '' : 'out', events.length || frees.length ? 'has-events' : 'no-events'].filter(Boolean).join(' ');
    return h('td', { class: cls, 'aria-current': c.ymd === today ? 'date' : null },
      h('span', { class: 'cal-date' },
        h('span', { class: 'num', 'aria-hidden': 'true' }, String(c.day)),
        h('span', { class: 'wd' }, formatDay(c.ymd))
      ),
      events.length ? h('ul', { class: 'cal-events' }, events.map((g) => {
        const s = getStage(g.stage);
        return h('li', null, h('button', { type: 'button', class: 'cal-event', dataset: { openGuest: g.id }, style: { background: s.bg, color: s.fg } },
          h('span', { class: 't' }, formatTime(g.recordingAt)),
          h('span', { class: 'n' }, displayName(g)),
          h('span', { class: 'sr-only' }, `, ${s.label}`)
        ));
      })) : null,
      frees.length ? h('ul', { class: 'cal-events' }, frees.map((r) => h('li', null,
        h('button', { type: 'button', class: 'cal-free', dataset: { openGuest: overlayGuest.id } },
          h('span', { class: 't' }, `${formatTime(r.start)}–${formatTime(r.end)}`),
          h('span', { class: 'n' }, `${displayName(overlayGuest)} free`)
        )))) : null
    );
  };

  fill(view,
    h('div', { class: 'cal-toolbar' },
      h('button', { type: 'button', class: 'btn btn-quiet btn-icon', id: 'cal-prev', dataset: { cal: '-1' }, 'aria-label': 'Previous month' }, icon('prev')),
      h('h2', { id: 'cal-label', 'aria-live': 'polite' }, monthLabel(year, month)),
      h('button', { type: 'button', class: 'btn btn-quiet btn-icon', id: 'cal-next', dataset: { cal: '1' }, 'aria-label': 'Next month' }, icon('next')),
      h('button', { type: 'button', class: 'btn btn-quiet', id: 'cal-today', dataset: { cal: 'today' } }, 'Today'),
      withFree.length ? h('label', { class: 'field cal-avail' }, 'Show availability for',
        h('select', { id: 'cal-avail' },
          h('option', { value: '' }, 'No one'),
          withFree.map((g) => h('option', { value: g.id, selected: overlayGuest?.id === g.id }, displayName(g))))) : null,
      h('div', { class: 'cal-legend', role: 'group', 'aria-label': 'Stage colours' }, STAGES.filter((s) => s.id !== 'outreach').map((s) => stagePill(s.id)))
    ),
    h('table', { class: 'cal' },
      h('caption', { class: 'sr-only' }, `Recordings in ${monthLabel(year, month)} (${tz()})`),
      h('thead', null, h('tr', null, WEEKDAY_NAMES.map((d) => h('th', { scope: 'col', abbr: d }, d.slice(0, 3))))),
      h('tbody', null, weeks.map((w) => h('tr', null, w.map(cell))))
    ),
    inMonthCount === 0 ? h('p', { class: 'cal-empty-note hint', style: { margin: 0 } }, `No recordings scheduled in ${monthLabel(year, month)}.`) : null,
    unscheduled.length ? h('section', { class: 'unscheduled', 'aria-labelledby': 'h-unsched' },
      h('h2', { class: 'section-label', id: 'h-unsched' }, 'Booked, no time set yet'),
      h('ul', { class: 'chip-list' }, unscheduled.map((g) => h('li', null, h('button', { type: 'button', class: 'btn btn-quiet btn-sm', dataset: { openGuest: g.id } }, displayName(g)))))
    ) : null
  );
}

function initCalendar() {
  $('#view-calendar').addEventListener('change', (e) => {
    if (e.target.id !== 'cal-avail') return;
    ui.calAvail = e.target.value;
    renderCalendar();
    $('#cal-avail').focus();
    const g = findGuest(ui.calAvail);
    if (!g) toast('Availability overlay off.');
    else {
      const n = upcomingRanges(g.freeSlots, '').length;
      toast(`Showing ${n} free range${n === 1 ? '' : 's'} for ${displayName(g)}.`);
    }
  });
  $('#view-calendar').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-cal]');
    if (nav) {
      if (nav.dataset.cal === 'today') {
        const t = parseLocal(todayYmd());
        ui.cal = { year: t.y, month: t.m };
      } else {
        ui.cal = shiftMonth(ui.cal.year, ui.cal.month, Number(nav.dataset.cal));
      }
      const id = nav.id;
      renderCalendar();
      document.getElementById(id)?.focus();
      return;
    }
    const open = e.target.closest('[data-open-guest]');
    if (open) openGuest(open.dataset.openGuest);
  });
}

/* ---------------------------------------------------------------- */
/* Email templates                                                   */
/* ---------------------------------------------------------------- */

function previewGuest() {
  return findGuest(ui.previewGuestId) || state.guests[0] || createGuest({ name: 'Alex Example', recordingAt: `${todayYmd()}T14:00` }, { idFn: () => 'preview' });
}

function renderTemplatePreview() {
  const t = state.templates.find((x) => x.id === ui.templateId);
  const pg = previewGuest();
  const mail = renderEmail(t, pg, state.settings, guestLinks(pg));
  $('#tpl-preview').replaceChildren(h('strong', null, mail.subject), mail.body);
}

function renderTemplates() {
  const view = $('#view-templates');
  const t = state.templates.find((x) => x.id === ui.templateId) || state.templates[0];
  const subject = h('input', { id: 'tpl-subject', type: 'text', dataset: { tplField: 'subject' }, autocomplete: 'off' });
  subject.value = t.subject;
  const body = h('textarea', { id: 'tpl-body', rows: 12, dataset: { tplField: 'body' } });
  body.value = t.body;
  const pg = previewGuest();

  view.replaceChildren(
    h('div', { class: 'two-col' },
      h('nav', { 'aria-label': 'Templates' },
        h('ul', { class: 'tpl-list' }, state.templates.map((x) =>
          h('li', null, h('button', { type: 'button', class: 'tpl-btn', dataset: { tpl: x.id }, 'aria-current': x.id === t.id ? 'true' : null }, x.name))
        ))
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px', minWidth: '0' } },
        h('div', { class: 'surface' },
          h('h2', null, t.name),
          h('p', null, 'Edits save automatically. Placeholders are filled in from each guest and your settings.'),
          h('label', { class: 'field' }, 'Subject', subject),
          h('div', { class: 'field' },
            h('span', { id: 'ph-label' }, 'Insert a placeholder ', h('span', { class: 'hint' }, '(at the cursor)')),
            h('div', { class: 'ph-list', role: 'group', 'aria-labelledby': 'ph-label' },
              PLACEHOLDERS.map((p) => h('button', { type: 'button', class: 'ph-btn', dataset: { insert: `{{${p}}}` } }, `{{${p}}}`))
            )
          ),
          h('label', { class: 'field' }, 'Body', body),
          h('div', { class: 'btn-row', style: { alignItems: 'center' } },
            h('span', { class: 'save-state', id: 'tpl-saved', 'aria-live': 'polite' }, 'All changes saved'),
            h('button', { type: 'button', class: 'btn btn-quiet', style: { flex: '0 0 auto' }, dataset: { action: 'reset-template' } }, 'Reset to default')
          )
        ),
        h('div', { class: 'surface' },
          h('h2', null, 'Preview'),
          h('label', { class: 'field' }, 'Preview with guest',
            h('select', { id: 'tpl-preview-guest' },
              state.guests.length
                ? sortGuests(state.guests, 'name').map((g) => h('option', { value: g.id, selected: g.id === pg.id }, displayName(g)))
                : h('option', { value: '' }, 'Example guest')
            )
          ),
          h('div', { class: 'email-preview', id: 'tpl-preview', tabindex: '0', 'aria-label': 'Rendered email preview', style: { maxHeight: 'none' } })
        )
      )
    )
  );
  renderTemplatePreview();
}

function updateTemplate(id, patch) {
  commit({ ...state, templates: state.templates.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, { main: false });
  renderTemplatePreview();
  // Changes are saved at once; the status settles after typing pauses so a
  // screen reader isn't told "saved" on every keystroke.
  const saved = $('#tpl-saved');
  if (!saved) return;
  if (saved.textContent !== 'Saving…') saved.textContent = 'Saving…';
  clearTimeout(updateTemplate.timer);
  updateTemplate.timer = setTimeout(() => {
    const el = $('#tpl-saved');
    if (el) el.textContent = `Saved at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }, 700);
}

function initTemplates() {
  const view = $('#view-templates');
  view.addEventListener('input', (e) => {
    const f = e.target.dataset.tplField;
    if (f) updateTemplate(ui.templateId, { [f]: e.target.value });
  });
  view.addEventListener('focusin', (e) => {
    if (e.target.dataset.tplField) ui.tplLastField = e.target.dataset.tplField;
  });
  view.addEventListener('change', (e) => {
    if (e.target.id === 'tpl-preview-guest') {
      ui.previewGuestId = e.target.value;
      renderTemplatePreview();
    }
  });
  view.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-tpl]');
    if (pick) {
      ui.templateId = pick.dataset.tpl;
      renderTemplates();
      view.querySelector(`[data-tpl="${cssId(pick.dataset.tpl)}"]`).focus();
      return;
    }
    const ins = e.target.closest('[data-insert]');
    if (ins) {
      const el = ui.tplLastField === 'subject' ? $('#tpl-subject') : $('#tpl-body');
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.setRangeText(ins.dataset.insert, start, end, 'end');
      el.focus();
      updateTemplate(ui.templateId, { [el.dataset.tplField]: el.value });
      return;
    }
    if (e.target.closest('[data-action="reset-template"]')) {
      const def = DEFAULT_TEMPLATES.find((d) => d.id === ui.templateId);
      if (!window.confirm(`Reset “${def.name}” to the default text?`)) return;
      updateTemplate(ui.templateId, { subject: def.subject, body: def.body });
      renderTemplates();
      $('#tpl-subject').focus();
      toast(`“${def.name}” reset to default.`);
    }
  });
}

/* ---------------------------------------------------------------- */
/* Episode plan + guest Q&A                                          */
/* ---------------------------------------------------------------- */

/** "Episode plans": guests with a plan or Q&A first, then everyone else. */
function renderPlans() {
  const view = $('#view-plans');
  const hasPlan = (g) => {
    const p = normalizePlan(g.plan);
    return !!(p.title || p.angle || p.segments.length || p.airQuestions.length || qaStatus(g) !== 'not-sent');
  };
  const list = sortGuests(filterGuests(state.guests, ui.query), 'recording');
  const started = list.filter(hasPlan);
  const rest = list.filter((g) => !hasPlan(g));
  const row = (g) => {
    const p = normalizePlan(g.plan);
    const t = segmentTimings(p.segments.filter((x) => x.text.trim()));
    const status = qaStatus(g);
    return h('li', { class: 'plans-row' },
      h('a', { class: 'plans-link', href: `#plan/${encodeURIComponent(g.id)}` },
        h('span', { class: 'nm' }, p.title || `Episode with ${displayName(g)}`),
        h('span', { class: 'hint' }, `${displayName(g)} · ${getStage(g.stage).label}${g.recordingAt ? ` · ${formatRecording(g.recordingAt)}` : ''}`)
      ),
      h('span', { class: 'mono plans-meta' }, `${t.rows.length} point${t.rows.length === 1 ? '' : 's'} · ${formatMinutes(t.total)}`),
      h('span', { class: `qa-chip qa-${status}` }, QA_STATUS_LABELS[status])
    );
  };
  fill(view,
    h('section', { class: 'surface', 'aria-labelledby': 'h-plans-started' },
      h('h2', { id: 'h-plans-started' }, 'Plans in progress'),
      started.length ? h('ul', { class: 'plans-list' }, started.map(row)) : h('p', { class: 'hint small' }, ui.query ? `No plans match “${ui.query}”.` : 'No plans yet. Open a guest below to start one.')
    ),
    rest.length ? h('section', { class: 'surface', 'aria-labelledby': 'h-plans-rest' },
      h('h2', { id: 'h-plans-rest' }, 'No plan yet'),
      h('ul', { class: 'plans-list' }, rest.map(row))
    ) : null
  );
}

/** Q&A link for a guest: carries their questions (capped to fit a URL). */
function qaUrl(g) {
  const qa = normalizeQa(g.qa);
  const questions = qa.questions.length ? qa.questions : seedQuestions(state.settings.questionBank, { idFn: (() => { let i = 0; return () => `b${++i}`; })() });
  const enc = encodeQuestions(questions);
  return { url: buildIntakeUrl(pageUrl('qa.html'), state.settings, { slots: false, guest: g, extra: { qs: enc.param } }), dropped: enc.dropped };
}

/**
 * Save the guest's questions (seeded from the bank) before any Q&A link is
 * built, so the link's question ids are the saved ones. Doesn't mark it sent.
 */
function ensureQaQuestions(g) {
  if (normalizeQa(g.qa).questions.length || !state.settings.questionBank.length) return g;
  const qa = { ...normalizeQa(g.qa), questions: seedQuestions(state.settings.questionBank) };
  const updated = { ...g, qa };
  state = upsertGuest(state, updated);
  saveState(state);
  return updated;
}

/** Make sure the guest's questions are saved before a link goes out, and stamp "sent". */
function prepareQa(g) {
  const updated = markQaSent(g, state.settings.questionBank, nowIso());
  saveGuest(updated, { main: false });
  return updated;
}

const planGuest = () => findGuest(ui.planGuestId);

function savePlan(g, plan, { rerender = false } = {}) {
  saveGuest({ ...g, plan, updatedAt: nowIso() }, { main: false });
  if (rerender) renderPlan();
}

function saveQa(g, qa, { rerender = false } = {}) {
  saveGuest({ ...g, qa, updatedAt: nowIso() }, { main: false });
  if (rerender) renderPlan();
}

/** Small icon button. "Unavailable" uses aria-disabled so focus never falls off it. */
function iconBtn(label, action, data, glyph, unavailable) {
  return h('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': label, title: label, dataset: { action, ...data }, 'aria-disabled': unavailable ? 'true' : null }, h('span', { 'aria-hidden': 'true' }, glyph));
}

function itemRows(list, kind, { minutes = false } = {}) {
  const noun = kind === 'segments' ? 'Talking point' : 'On-air question';
  return list.map((it, i) => h('li', { class: 'plan-item' },
    h('span', { class: 'plan-num', 'aria-hidden': 'true' }, String(i + 1)),
    h('label', { class: 'plan-text' }, h('span', { class: 'sr-only' }, `${noun} ${i + 1}`),
      (() => { const t = h('textarea', { id: `${kind}-${it.id}-text`, rows: 2, dataset: { list: kind, item: it.id, prop: 'text' } }); t.value = it.text; return t; })()),
    h('div', { class: 'plan-row2' },
      minutes ? h('label', { class: 'plan-min' }, h('span', { class: 'hint', 'aria-hidden': 'true' }, 'Minutes'),
        (() => { const m = h('input', { id: `${kind}-${it.id}-min`, type: 'number', min: '0', max: '600', inputmode: 'numeric', dataset: { list: kind, item: it.id, prop: 'minutes' }, 'aria-label': `Minutes for ${noun.toLowerCase()} ${i + 1}` }); m.value = it.minutes || ''; return m; })()) : h('span'),
      h('div', { class: 'plan-tools' },
        iconBtn(`Move ${noun.toLowerCase()} ${i + 1} up`, 'item-up', { list: kind, item: it.id }, '↑', i === 0),
        iconBtn(`Move ${noun.toLowerCase()} ${i + 1} down`, 'item-down', { list: kind, item: it.id }, '↓', i === list.length - 1),
        iconBtn(`Delete ${noun.toLowerCase()} ${i + 1}`, 'item-delete', { list: kind, item: it.id }, '×')
      )
    )
  ));
}

function addRow(kind, label, { minutes = false } = {}) {
  return h('div', { class: 'inline-add' },
    h('label', { class: 'field' }, label, h('input', { id: `add-${kind}`, type: 'text', autocomplete: 'off' })),
    minutes ? h('label', { class: 'field plan-min' }, 'Minutes', h('input', { id: `add-${kind}-min`, type: 'number', min: '0', max: '600', inputmode: 'numeric' })) : null,
    h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'item-add', list: kind } }, 'Add')
  );
}

function answeredLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `Answered ${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function renderPlan() {
  const view = $('#view-plan');
  const g = planGuest();
  if (!g) return;
  const plan = normalizePlan(g.plan);
  const qa = normalizeQa(g.qa);
  // Same rule as the run sheet: blank talking points don't count toward the total.
  const t = segmentTimings(plan.segments.filter((x) => x.text.trim()));
  const status = qaStatus(g);
  const link = qaUrl(g);
  const title = h('input', { id: 'plan-title', type: 'text', dataset: { planField: 'title' }, autocomplete: 'off', placeholder: `Episode with ${displayName(g)}` });
  title.value = plan.title;
  const angle = h('textarea', { id: 'plan-angle', rows: 3, dataset: { planField: 'angle' } });
  angle.value = plan.angle;

  fill(view,
    h('div', { class: 'plan-toolbar' },
      h('a', { class: 'btn btn-quiet', href: '#pipeline' }, '← Back to pipeline'),
      h('button', { type: 'button', class: 'btn btn-quiet', dataset: { openGuest: g.id } }, `Open ${displayName(g)}’s details`),
      h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'print-sheet' } }, 'Print run sheet'),
      h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'download-sheet' } }, 'Download run sheet (.txt)')
    ),
    h('div', { class: 'plan-grid' },
      h('div', { class: 'plan-col' },
        h('section', { class: 'surface', 'aria-labelledby': 'h-episode' },
          h('h2', { id: 'h-episode' }, 'Episode'),
          h('label', { class: 'field' }, 'Working title', title),
          h('label', { class: 'field' }, 'Angle / summary', angle)
        ),
        h('section', { class: 'surface', 'aria-labelledby': 'h-segments' },
          h('div', { class: 'panel-section-head' },
            h('h2', { id: 'h-segments' }, 'Talking points'),
            h('span', { class: 'mono plan-total', id: 'seg-total', role: 'status', 'aria-live': 'polite' }, `Total ${formatMinutes(t.total)}`)
          ),
          plan.segments.length ? h('ol', { class: 'plan-list' }, itemRows(plan.segments, 'segments', { minutes: true })) : h('p', { class: 'hint small' }, 'No talking points yet.'),
          addRow('segments', 'New talking point', { minutes: true })
        ),
        h('section', { class: 'surface', 'aria-labelledby': 'h-air' },
          h('h2', { id: 'h-air' }, 'Questions to ask on air'),
          plan.airQuestions.length ? h('ol', { class: 'plan-list' }, itemRows(plan.airQuestions, 'airQuestions')) : h('p', { class: 'hint small' }, 'No on-air questions yet. Promote a guest answer or add your own.'),
          addRow('airQuestions', 'New on-air question')
        )
      ),
      h('div', { class: 'plan-col' },
        h('section', { class: 'surface', 'aria-labelledby': 'h-qa' },
          h('div', { class: 'panel-section-head' },
            h('h2', { id: 'h-qa' }, 'Questions for the guest'),
            h('span', { class: `qa-chip qa-${status}` }, QA_STATUS_LABELS[status])
          ),
          h('p', null, 'A short pre-interview questionnaire. Share the link and the answers arrive with “Check for new submissions”.'),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'copy-qa' } }, 'Copy Q&A link'),
            h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'email-qa' } }, 'Email the questions')
          ),
          link.dropped ? h('p', { class: 'note-warn' }, `${link.dropped} question${link.dropped === 1 ? '' : 's'} didn’t fit in the link and won’t be shown to the guest. Shorten or remove some questions.`) : null,
          qa.questions.length
            ? h('ol', { class: 'qa-list' }, qa.questions.map((q, i) => {
              const a = qa.answers[q.id];
              return h('li', { class: 'qa-item' },
                h('div', { class: 'plan-item' },
                  h('span', { class: 'plan-num', 'aria-hidden': 'true' }, String(i + 1)),
                  h('label', { class: 'plan-text' }, h('span', { class: 'sr-only' }, `Question ${i + 1}`),
                    (() => { const t2 = h('textarea', { id: `questions-${q.id}-text`, rows: 2, maxlength: String(QA_LIMITS.question), dataset: { list: 'questions', item: q.id, prop: 'text' } }); t2.value = q.text; return t2; })()),
                  h('div', { class: 'plan-row2' }, h('span'),
                    h('div', { class: 'plan-tools' },
                      iconBtn(`Move question ${i + 1} up`, 'item-up', { list: 'questions', item: q.id }, '↑', i === 0),
                      iconBtn(`Move question ${i + 1} down`, 'item-down', { list: 'questions', item: q.id }, '↓', i === qa.questions.length - 1),
                      iconBtn(`Delete question ${i + 1}`, 'item-delete', { list: 'questions', item: q.id }, '×')
                    ))
                ),
                a && a.text ? h('div', { class: 'qa-answer' },
                  h('p', { class: 'qa-answer-meta mono' }, answeredLabel(a.answeredAt)),
                  h('blockquote', null, a.text),
                  h('div', { class: 'btn-row' },
                    h('button', { type: 'button', class: 'btn btn-quiet btn-sm', dataset: { action: 'promote', target: 'segment', q: q.id }, 'aria-label': `Add the answer to question ${i + 1} as a talking point` }, '→ Talking point'),
                    h('button', { type: 'button', class: 'btn btn-quiet btn-sm', dataset: { action: 'promote', target: 'air', q: q.id }, 'aria-label': `Add the answer to question ${i + 1} as an on-air question` }, '→ On-air question')
                  )
                ) : h('p', { class: 'hint small' }, status === 'not-sent' ? 'Not sent yet.' : 'No answer yet.')
              );
            }))
            : h('p', { class: 'hint small' }, 'No questions yet.'),
          addRow('questions', 'Add a custom question'),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn btn-quiet', dataset: { action: 'seed-questions' } }, qa.questions.length ? 'Add questions from the bank' : 'Use the question bank')
          ),
          qa.topics ? h('div', { class: 'qa-answer' },
            h('h3', { class: 'section-label' }, 'Topics the guest would love to talk about'),
            h('p', { class: 'qa-answer-meta mono' }, answeredLabel(qa.topicsAt)),
            h('blockquote', null, qa.topics)
          ) : null
        )
      )
    )
  );
}

function itemListFor(g, kind) {
  if (kind === 'questions') return normalizeQa(g.qa).questions;
  return normalizePlan(g.plan)[kind];
}

function saveItemList(g, kind, list, opts) {
  if (kind === 'questions') return saveQa(g, { ...normalizeQa(g.qa), questions: list }, opts);
  return savePlan(g, { ...normalizePlan(g.plan), [kind]: list }, opts);
}

function focusAfterRender(id) {
  const el = document.getElementById(id);
  if (el) el.focus();
}

function renderSheetForPrint(g) {
  const sheet = runSheet(g, { showName: state.settings.showName, recordingLabel: g.recordingAt ? `${formatRecording(g.recordingAt)} (${tz()})` : '' });
  const out = $('#print-sheet');
  const section = (title, ...body) => h('section', null, h('h2', null, title), ...body);
  fill(out,
    h('p', { class: 'ps-show' }, sheet.show),
    h('h1', null, sheet.title),
    h('p', { class: 'ps-meta' }, `Guest: ${sheet.guest || '-'}${sheet.pronouns ? ` (${sheet.pronouns})` : ''}${sheet.role ? `, ${sheet.role}` : ''}`, sheet.recording ? h('br') : null, sheet.recording ? `Recording: ${sheet.recording}` : null),
    sheet.angle ? section('Angle', h('p', null, sheet.angle)) : null,
    sheet.intro ? section('Intro / bio', h('p', null, sheet.intro)) : null,
    section(`Talking points (${formatMinutes(sheet.totalMinutes)})`,
      sheet.segments.length ? h('ol', null, sheet.segments.map((x) => h('li', null, x.text, x.minutes ? h('span', { class: 'ps-time' }, ` ${x.minutes} min · ${x.start}–${x.end}`) : null))) : h('p', null, '-')),
    section('On-air questions', sheet.airQuestions.length ? h('ol', null, sheet.airQuestions.map((q) => h('li', null, q.text))) : h('p', null, '-')),
    section('Guest answers', sheet.answers.length ? h('dl', null, sheet.answers.map((a) => [h('dt', null, a.question), h('dd', null, a.answer)])) : h('p', null, '-')),
    sheet.topics ? section('Topics the guest would love to talk about', h('p', null, sheet.topics)) : null
  );
  return sheet;
}

function initPlan() {
  const view = $('#view-plan');
  // Any print from the Episode plan (the button or Ctrl+P) prints the current run
  // sheet; other views print normally.
  window.addEventListener('beforeprint', () => {
    const g = ui.view === 'plan' ? planGuest() : null;
    document.body.classList.toggle('printing-sheet', !!g);
    if (g) renderSheetForPrint(g);
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('printing-sheet'));
  // Show the stored (clamped) minutes once the person leaves the field.
  view.addEventListener('change', (e) => {
    const { list, item, prop } = e.target.dataset;
    const g = planGuest();
    if (!g || list !== 'segments' || prop !== 'minutes') return;
    const it = itemListFor(g, list).find((x) => x.id === item);
    if (it) e.target.value = it.minutes || '';
  });
  view.addEventListener('input', (e) => {
    const g = planGuest();
    if (!g) return;
    const f = e.target.dataset.planField;
    if (f) return savePlan(g, { ...normalizePlan(g.plan), [f]: e.target.value });
    const { list, item, prop } = e.target.dataset;
    if (!list || !item) return;
    const updated = updateItem(itemListFor(g, list), item, { [prop]: e.target.value });
    saveItemList(g, list, updated);
    if (list === 'segments' && prop === 'minutes') $('#seg-total').textContent = `Total ${formatMinutes(segmentTimings(updated).total)}`;
  });
  view.addEventListener('keydown', (e) => {
    // Enter in an "add" field adds the item.
    if (e.key === 'Enter' && e.target.id?.startsWith('add-')) {
      e.preventDefault();
      const kind = e.target.id.replace(/^add-/, '').replace(/-min$/, '');
      view.querySelector(`[data-action="item-add"][data-list="${kind}"]`)?.click();
    }
  });
  view.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open-guest]');
    if (open) return openGuest(open.dataset.openGuest);
    const btn = e.target.closest('[data-action]');
    const g = planGuest();
    if (!btn || !g) return;
    if (btn.getAttribute('aria-disabled') === 'true') {
      if (btn.dataset.action === 'item-up') toast('Already first.');
      else if (btn.dataset.action === 'item-down') toast('Already last.');
      return;
    }
    const { action, list, item } = btn.dataset;
    if (action === 'item-add') {
      const input = $(`#add-${list}`);
      const text = input.value.trim();
      if (!text) { toast('Type something to add first.'); input.focus(); return; }
      const min = $(`#add-${list}-min`);
      const next = addItem(itemListFor(g, list), text, { idFn: () => `${list[0]}${Date.now().toString(36)}`, minutes: min ? min.value : undefined });
      saveItemList(g, list, next, { rerender: true });
      focusAfterRender(`add-${list}`);
      toast('Added.');
    } else if (action === 'item-up' || action === 'item-down') {
      const moved = moveItem(itemListFor(g, list), item, action === 'item-up' ? -1 : 1);
      saveItemList(g, list, moved, { rerender: true });
      // Focus stays on the same button of the moved item (it may now be unavailable, but stays focusable).
      view.querySelector(`[data-action="${action}"][data-item="${cssId(item)}"]`)?.focus();
      toast(`Moved to position ${moved.findIndex((x) => x.id === item) + 1} of ${moved.length}.`);
    } else if (action === 'item-delete') {
      const current = itemListFor(g, list);
      const idx = current.findIndex((x) => x.id === item);
      saveItemList(g, list, removeItem(current, item), { rerender: true });
      const rest = itemListFor(planGuest(), list);
      focusAfterRender(rest.length ? `${list}-${rest[Math.min(idx, rest.length - 1)].id}-text` : `add-${list}`);
      toast('Deleted.');
    } else if (action === 'promote') {
      const updated = promoteAnswer(g, btn.dataset.q, btn.dataset.target, { idFn: () => `p${Date.now().toString(36)}`, nowIso: nowIso() });
      const where = btn.dataset.target === 'air' ? 'on-air questions' : 'talking points';
      if (updated === g) return toast(`Already in ${where}.`);
      saveGuest(updated, { main: false });
      renderPlan();
      view.querySelector(`[data-action="promote"][data-q="${cssId(btn.dataset.q)}"][data-target="${btn.dataset.target}"]`)?.focus();
      toast(`Added to ${where}.`);
    } else if (action === 'seed-questions') {
      const qa = normalizeQa(g.qa);
      const have = new Set(qa.questions.map((q) => q.text.trim().toLowerCase()));
      const fresh = seedQuestions(state.settings.questionBank).filter((q) => !have.has(q.text.trim().toLowerCase()));
      const room = QA_LIMITS.questions - qa.questions.length;
      saveQa(g, { ...qa, questions: [...qa.questions, ...fresh.slice(0, Math.max(0, room))] }, { rerender: true });
      $('[data-action="seed-questions"]')?.focus();
      toast(fresh.length ? `Added ${Math.min(fresh.length, room)} question${fresh.length === 1 ? '' : 's'} from the bank.` : 'Every bank question is already on the list.');
    } else if (action === 'copy-qa') {
      const updated = prepareQa(g);
      const link = qaUrl(updated);
      renderPlan();
      $('[data-action="copy-qa"]')?.focus();
      toast((await copyText(link.url)) ? 'Q&A link copied.' : 'Could not copy the link.');
    } else if (action === 'email-qa') {
      const updated = prepareQa(g);
      renderPlan();
      window.location.href = templateMailto(updated, 'qa');
    } else if (action === 'print-sheet') {
      window.print(); // beforeprint fills in the run sheet
    } else if (action === 'download-sheet') {
      const sheet = renderSheetForPrint(g);
      const safe = displayName(g).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'guest';
      download(`run-sheet-${safe}.txt`, runSheetToText(sheet), 'text/plain;charset=utf-8');
      toast('Run sheet downloaded.');
    }
  });
}

/* ---------------------------------------------------------------- */
/* Settings                                                          */
/* ---------------------------------------------------------------- */

function timeZoneOptions(current) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  return [...new Set(['UTC', browserTimeZone(), current, ...zones])].filter(isValidTimeZone).sort();
}

function pageUrl(file) {
  const base = new URL(file, window.location.href);
  base.search = '';
  base.hash = '';
  return base.href;
}

function intakeUrl() {
  return buildIntakeUrl(pageUrl('intake.html'), state.settings, { nowLocal: nowInZone(tz()) });
}

/** Availability calendar link; with a guest it pre-fills their id, name and email. */
function availabilityUrl(g) {
  return buildIntakeUrl(pageUrl('availability.html'), state.settings, { slots: false, guest: g || undefined });
}

/** Per-guest links used by the {{availability_link}} and {{qa_link}} placeholders. */
function guestLinks(g) {
  const links = { availabilityLink: availabilityUrl(g) };
  links.qaLink = qaUrl(ensureQaQuestions(g)).url;
  return links;
}

function renderSettings() {
  const view = $('#view-settings');
  const s = state.settings;
  const input = (attrs, value) => { const el = h('input', attrs); el.value = value; return el; };

  view.replaceChildren(
    h('div', { class: 'settings-grid' },
      h('section', { class: 'surface', 'aria-labelledby': 'h-show' },
        h('h2', { id: 'h-show' }, 'Your show'),
        h('p', null, 'Used in email templates and on the guest intake form.'),
        h('label', { class: 'field' }, 'Show name', input({ id: 'set-show', type: 'text', dataset: { setting: 'showName' }, autocomplete: 'off' }, s.showName)),
        h('label', { class: 'field' }, 'Host time zone',
          h('span', { class: 'hint' }, 'Recording times are entered and shown in this zone.'),
          h('select', { id: 'set-tz', dataset: { setting: 'timeZone' } }, timeZoneOptions(s.timeZone).map((z) => h('option', { value: z, selected: z === s.timeZone }, z.replace(/_/g, ' '))))
        ),
        h('label', { class: 'field' }, h('span', null, 'Host email ', h('span', { class: 'hint' }, '(optional: lets guests email their intake answers to you)')),
          input({ id: 'set-email', type: 'email', dataset: { setting: 'hostEmail' }, autocomplete: 'email' }, s.hostEmail))
      ),

      h('section', { class: 'surface', 'aria-labelledby': 'h-intake' },
        h('h2', { id: 'h-intake' }, 'Guest intake form'),
        h('p', null, 'Times guests can pick from. With none set, the form suggests the next Monday, Wednesday and Friday at 10 AM and 2 PM.'),
        s.intakeSlots.length
          ? h('ul', { class: 'slot-list' }, s.intakeSlots.map((slot) => h('li', null,
            h('span', null, `${formatDay(slot)} · ${formatTime(slot)}`),
            h('button', { type: 'button', class: 'btn btn-quiet btn-sm', dataset: { removeSlot: slot }, 'aria-label': `Remove ${formatDay(slot)} ${formatTime(slot)}` }, 'Remove')
          )))
          : h('p', { class: 'hint', style: { margin: 0, fontSize: '14px' } }, 'No custom times yet.'),
        h('div', { class: 'inline-add' },
          h('label', { class: 'field' }, `New time (${s.timeZone})`, h('input', { id: 'slot-new', type: 'datetime-local' })),
          h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'add-slot' } }, 'Add time')
        ),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-quiet', dataset: { action: 'suggest-slots' } }, 'Use suggested times'),
          s.intakeSlots.length ? h('button', { type: 'button', class: 'btn btn-quiet', dataset: { action: 'clear-slots' } }, 'Clear times') : null
        ),
        h('div', { class: 'field' }, 'Shareable link',
          h('span', { class: 'hint' }, 'Carries your show name, time zone, email, times and (if set) the endpoint URL, so a remote guest sees the right details and their answers reach your sheet. It never contains your read key.'),
          h('div', { class: 'share-url', id: 'share-url' }, intakeUrl())
        ),
        h('p', { class: 'note-warn', id: 'no-email-warn', hidden: !!s.hostEmail }, 'No host email is set, so a guest who emails their answers will have to type your address themselves. Add your email above.'),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'copy-intake' }, 'aria-describedby': s.hostEmail ? null : 'no-email-warn' }, 'Copy link'),
          h('a', { class: 'btn btn-quiet', id: 'open-intake', href: intakeUrl(), target: '_blank', rel: 'noopener' }, 'Open form ↗')
        ),
        h('div', { class: 'field' }, 'Availability calendar link',
          h('span', { class: 'hint' }, 'A week grid where guests mark when they’re free. From a guest’s panel you can send a personal link instead.'),
          h('div', { class: 'share-url', id: 'share-avail-url' }, availabilityUrl())
        ),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'copy-avail-link' } }, 'Copy availability link'),
          h('a', { class: 'btn btn-quiet', id: 'open-avail', href: availabilityUrl(), target: '_blank', rel: 'noopener' }, 'Open calendar ↗')
        )
      ),

      backendSection(),

      h('section', { class: 'surface span-2', 'aria-labelledby': 'h-bank' },
        h('h2', { id: 'h-bank' }, 'Q&A question bank'),
        h('p', null, `Default pre-interview questions. A guest’s episode plan starts from these, and you can edit them per guest. One question per line, up to ${QA_LIMITS.questions}.`),
        h('label', { class: 'field' }, 'Questions',
          (() => { const t = h('textarea', { id: 'set-bank', rows: 8, 'aria-describedby': 'bank-count' }); t.value = s.questionBank.join('\n'); return t; })(),
          h('span', { class: 'hint', id: 'bank-count' }, `${s.questionBank.length} question${s.questionBank.length === 1 ? '' : 's'}`)
        )
      ),

      h('section', { class: 'surface span-2', 'aria-labelledby': 'h-data' },
        h('h2', { id: 'h-data' }, 'Backup and data'),
        h('p', null, 'Everything is stored in this browser only. Export a JSON backup regularly, and import it to restore or move to another browser.'),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'export' } }, 'Export JSON'),
          h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'import' } }, 'Import JSON'),
          h('button', { type: 'button', class: 'btn btn-quiet', dataset: { action: 'clear-samples' }, disabled: !hasSamples(state) }, 'Clear sample data'),
          h('button', { type: 'button', class: 'btn btn-danger', dataset: { action: 'reset-all' } }, 'Erase everything')
        )
      )
    )
  );
}

/* ---------------------------------------------------------------- */
/* Intake backend (Google Apps Script)                               */
/* ---------------------------------------------------------------- */

// The read key is only sent to the endpoint it was entered for (see keyUsable).
const backendReady = () => keyUsable(sync, state.settings.intakeEndpoint);
const keyNeedsReentry = () => !!(sync.readKey && state.settings.intakeEndpoint && !backendReady());

function lastCheckedText() {
  if (!sync.lastSync) return 'Not checked yet.';
  const d = new Date(sync.lastSync);
  return `Last checked ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
}

function backendSection() {
  const s = state.settings;
  const endpoint = h('input', { id: 'set-endpoint', type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://script.google.com/macros/s/…/exec', 'aria-describedby': 'endpoint-help endpoint-warn' });
  endpoint.value = s.intakeEndpoint;
  const key = h('input', { id: 'set-readkey', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'readkey-help' });
  key.value = sync.readKey;
  return h('section', { class: 'surface span-2', 'aria-labelledby': 'h-backend' },
    h('h2', { id: 'h-backend' }, 'Intake backend (Google Sheet)'),
    h('p', null, 'Connect a free Google Apps Script web app so guests’ intake answers, availability and Q&A reach you from their own devices. The README has step-by-step setup.'),
    h('div', { class: 'field-grid' },
      h('label', { class: 'field span-2' }, 'Intake endpoint URL',
        h('span', { class: 'hint', id: 'endpoint-help' }, 'The web app URL from Deploy → Web app (https://script.google.com/macros/s/…/exec; other addresses aren’t accepted). Share links include it so guests’ answers are posted to your sheet. It can’t read anything.'),
        endpoint,
        h('span', { class: 'field-error', id: 'endpoint-warn', hidden: true })
      ),
      h('div', { class: 'field span-2' },
        h('label', { for: 'set-readkey' }, 'Read key'),
        h('span', { class: 'hint', id: 'readkey-help' }, 'From setup() in Apps Script. Stays in this browser only: it is never put in a share link or in Export JSON.'),
        h('div', { class: 'inline-add' }, key,
          h('button', { type: 'button', class: 'btn btn-quiet', dataset: { action: 'toggle-key' }, 'aria-pressed': 'false', 'aria-controls': 'set-readkey' }, 'Show key'))
      )
    ),
    h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', id: 'set-autocheck', checked: sync.autoCheck }),
      h('span', null, 'Check for new submissions when the app opens')
    ),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-outline', dataset: { action: 'test-backend' } }, 'Test connection'),
      h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'check-submissions' } }, 'Check for new submissions')
    ),
    h('p', { class: 'backend-status', id: 'backend-status', role: 'status', 'aria-live': 'polite' }, backendReady() ? lastCheckedText() : '')
  );
}

function setBackendStatus(text) {
  const el = $('#backend-status');
  if (el) el.textContent = text;
}

function syncHeadCheck() {
  const btn = $('#head-check');
  if (btn) btn.hidden = !backendReady();
}

let checking = false;

/**
 * Fetch new submissions and import them: new guests land in Outreach,
 * submissions from a known guest (same id or email) merge into that guest,
 * and ids already imported are skipped.
 */
async function checkSubmissions({ quiet = false } = {}) {
  if (checking) return;
  if (!backendReady()) {
    setBackendStatus(keyNeedsReentry() ? 'The read key was entered for a different endpoint. Paste it again in Settings.' : 'Add the endpoint URL and read key first.');
    if (!quiet) toast('Set up the intake backend in Settings first.');
    return;
  }
  checking = true;
  const buttons = [...document.querySelectorAll('[data-action="check-submissions"]')];
  // aria-disabled, not disabled: disabling the focused button would drop focus to the page.
  for (const b of buttons) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-busy', 'true'); }
  setBackendStatus('Checking for new submissions…');
  const startedAt = nowIso();
  try {
    const res = await fetchSubmissions(state.settings.intakeEndpoint, sync.readKey, sinceFor(sync.lastSync));
    if (!res.ok) {
      const msg = res.keyRejected ? 'The read key was not accepted. Copy it again from Apps Script (setup() logs it) and paste it here.' : res.error;
      setBackendStatus(msg);
      if (!quiet) toast(msg);
      return;
    }
    const result = applySubmissions(state, res.submissions, { seenIds: sync.seenIds, nowIso: nowIso() });
    sync = { ...sync, seenIds: result.seenIds, lastSync: res.now || startedAt };
    saveSync(sync);
    if (result.touched.length) commit(result.state);
    if (ui.selectedId && result.touched.includes(ui.selectedId)) renderPanel();
    const summary = importSummary(result.counts);
    setBackendStatus(`${summary} ${lastCheckedText()}`);
    if (!quiet || result.touched.length) toast(result.touched.length ? `${summary} New guests are in Outreach.` : summary);
  } catch (err) {
    setBackendStatus(`Could not check: ${err.message}`);
    if (!quiet) toast(`Could not check: ${err.message}`);
  } finally {
    checking = false;
    for (const b of document.querySelectorAll('[data-action="check-submissions"]')) { b.removeAttribute('aria-disabled'); b.removeAttribute('aria-busy'); }
  }
}

async function testBackend() {
  const url = normalizeEndpoint($('#set-endpoint')?.value || state.settings.intakeEndpoint);
  if (!url) {
    setBackendStatus('Enter the web app URL first. It starts with https://script.google.com/macros/s/');
    $('#set-endpoint')?.focus();
    return;
  }
  setBackendStatus('Testing the connection…');
  try {
    await checkHealth(url);
    if (!keyUsable(sync, url)) {
      setBackendStatus(sync.readKey ? 'Connected. Paste the read key for this endpoint to import submissions.' : 'Connected. Now paste the read key to import submissions.');
      return;
    }
    const res = await fetchSubmissions(url, sync.readKey, new Date().toISOString());
    setBackendStatus(res.ok ? 'Connected, and the read key works.' : res.keyRejected ? 'Connected, but the read key was not accepted.' : `Connected, but listing failed: ${res.error}`);
  } catch (err) {
    setBackendStatus(`Connection failed: ${err.message}`);
  }
}

function updateSettings(patch, { rerender = false } = {}) {
  commit({ ...state, settings: { ...state.settings, ...patch } }, { main: rerender });
  const share = $('#share-url');
  if (share) share.textContent = intakeUrl();
  const open = $('#open-intake');
  if (open) open.href = intakeUrl();
  if ($('#share-avail-url')) $('#share-avail-url').textContent = availabilityUrl();
  if ($('#open-avail')) $('#open-avail').href = availabilityUrl();
  const warn = $('#no-email-warn');
  if (warn) {
    warn.hidden = !!state.settings.hostEmail;
    const copy = $('[data-action="copy-intake"]');
    if (state.settings.hostEmail) copy?.removeAttribute('aria-describedby');
    else copy?.setAttribute('aria-describedby', 'no-email-warn');
  }
  document.title = `${VIEWS[ui.view].title} · ${state.settings.showName} · Guest Manager`;
}

function initSettings() {
  const view = $('#view-settings');
  view.addEventListener('input', (e) => {
    const key = e.target.dataset.setting;
    if (key === 'showName') updateSettings({ showName: e.target.value.trim() ? e.target.value : 'My Podcast' });
    else if (key === 'hostEmail') updateSettings({ hostEmail: e.target.value.trim() });
    else if (e.target.id === 'set-endpoint') {
      const raw = e.target.value.trim();
      const url = normalizeEndpoint(raw);
      const warn = $('#endpoint-warn');
      const bad = raw && !url;
      warn.hidden = !bad;
      warn.textContent = bad ? 'Enter the full https:// web app URL.' : '';
      if (bad) e.target.setAttribute('aria-invalid', 'true');
      else e.target.removeAttribute('aria-invalid');
      if (!bad) {
        updateSettings({ intakeEndpoint: url });
        // A key typed before any endpoint belongs to the first one the host enters here.
        if (sync.readKey && !sync.keyEndpoint && url) {
          sync = { ...sync, keyEndpoint: url };
          saveSync(sync);
        }
        syncHeadCheck();
        if (keyNeedsReentry()) setBackendStatus('The endpoint changed. Paste the read key again for this endpoint before checking.');
      }
    } else if (e.target.id === 'set-bank') {
      const bank = normalizeQuestionBank(e.target.value.split('\n'));
      updateSettings({ questionBank: bank });
      $('#bank-count').textContent = `${bank.length} question${bank.length === 1 ? '' : 's'}${e.target.value.split('\n').filter((l) => l.trim()).length > bank.length ? ` (only the first ${QA_LIMITS.questions} are used)` : ''}`;
    } else if (e.target.id === 'set-readkey') {
      // Remember which endpoint this key belongs to; it is never sent anywhere else.
      sync = { ...sync, readKey: e.target.value.trim(), keyEndpoint: normalizeEndpoint(state.settings.intakeEndpoint) };
      saveSync(sync);
      syncHeadCheck();
    }
  });
  view.addEventListener('focusout', (e) => {
    // An emptied show name falls back to the saved one; show it rather than leaving the field blank.
    if (e.target.dataset.setting === 'showName' && !e.target.value.trim()) {
      e.target.value = state.settings.showName;
      toast(`The show name can’t be empty, so it stays “${state.settings.showName}”.`);
    }
  });
  view.addEventListener('change', (e) => {
    if (e.target.id === 'set-autocheck') {
      sync = { ...sync, autoCheck: e.target.checked };
      saveSync(sync);
      return;
    }
    if (e.target.dataset.setting === 'timeZone' && isValidTimeZone(e.target.value)) {
      updateSettings({ timeZone: e.target.value }, { rerender: true });
      $('#set-tz').focus();
      toast(`Time zone set to ${e.target.value}.`);
    }
  });
  view.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove-slot]');
    if (rm) {
      const slot = rm.dataset.removeSlot;
      updateSettings({ intakeSlots: state.settings.intakeSlots.filter((s) => s !== slot) }, { rerender: true });
      $('#slot-new').focus();
      toast(`Removed ${formatDay(slot)} · ${formatTime(slot)}.`);
      return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'toggle-key') {
      const btn = e.target.closest('[data-action]');
      const input = $('#set-readkey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.textContent = show ? 'Hide key' : 'Show key';
      return;
    }
    if (action === 'test-backend') return testBackend();
    if (action === 'add-slot') {
      const val = $('#slot-new').value;
      const p = parseLocal(val);
      if (!p || !p.hasTime) {
        toast('Pick a date and time first.');
        $('#slot-new').focus();
        return;
      }
      const slot = toLocalString(p);
      updateSettings({ intakeSlots: [...new Set([...state.settings.intakeSlots, slot])].sort() }, { rerender: true });
      $('#slot-new').focus();
      toast(`Added ${formatDay(slot)} · ${formatTime(slot)}.`);
    } else if (action === 'suggest-slots') {
      updateSettings({ intakeSlots: suggestSlots(todayYmd()) }, { rerender: true });
      $('[data-action="suggest-slots"]').focus();
      toast('Added suggested times for the coming week.');
    } else if (action === 'clear-slots') {
      const n = state.settings.intakeSlots.length;
      updateSettings({ intakeSlots: [] }, { rerender: true });
      $('[data-action="suggest-slots"]').focus();
      toast(`Cleared ${n} time${n === 1 ? '' : 's'}. The form will suggest times instead.`);
    } else if (action === 'copy-avail-link') {
      toast((await copyText(availabilityUrl())) ? 'Availability link copied.' : 'Could not copy. Select the link text and copy it yourself.');
    } else if (action === 'copy-intake') {
      toast((await copyText(intakeUrl())) ? 'Intake link copied.' : 'Could not copy. Select the link text and copy it yourself.');
    } else if (action === 'export') {
      download(`guest-manager-backup-${todayYmd()}.json`, serializeState(state, nowIso()));
      toast(`Exported ${state.guests.length} guests.`);
    } else if (action === 'import') {
      $('#import-file').click();
    } else if (action === 'reset-all') {
      if (!window.confirm('Erase all guests, templates and settings in this browser and start again with sample data? Export a backup first if you might need it.')) return;
      if (ui.selectedId) closePanel({ restore: false });
      commit(createInitialState({ timeZone: browserTimeZone(), today: nowInZone(browserTimeZone()).slice(0, 10) }));
      $('[data-action="reset-all"]').focus();
      toast('Started fresh with sample data.');
    }
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const next = parseState(await file.text(), { timeZone: browserTimeZone() });
      if (!window.confirm(`Replace everything in this browser with the backup “${file.name}” (${next.guests.length} guests)?`)) return;
      // A backup can't silently change where the app talks to (and sends the read key).
      const current = state.settings.intakeEndpoint;
      const incoming = next.settings.intakeEndpoint;
      if (incoming !== current) {
        const useIt = incoming && window.confirm(`The backup uses a different intake endpoint on ${endpointHost(incoming)}:\n${incoming}\n\nUse it? Choose Cancel to keep your current endpoint${current ? ` (${endpointHost(current)})` : ''}. If you use it, you’ll need to paste its read key again.`);
        if (!useIt) next.settings = { ...next.settings, intakeEndpoint: current };
      }
      if (ui.selectedId) closePanel({ restore: false });
      commit(next);
      setView(ui.view);
      toast(`Imported ${next.guests.length} guests.`);
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  });
}

/** Tell screen reader users how many guests match, once typing pauses. */
function announceSearch() {
  clearTimeout(announceSearch.timer);
  announceSearch.timer = setTimeout(() => {
    const q = ui.query.trim();
    const n = q ? filterGuests(state.guests, q).length : state.guests.length;
    const out = $('#search-status');
    if (!q) out.textContent = `Showing all ${n} guest${n === 1 ? '' : 's'}.`;
    else out.textContent = n ? `${n} ${n === 1 ? 'guest matches' : 'guests match'} “${q}”.` : `No guests match “${q}”.`;
  }, 400);
}

function clearSampleData() {
  const n = state.guests.filter((g) => g.sample).length;
  if (!n) return;
  if (ui.selectedId && findGuest(ui.selectedId)?.sample) closePanel({ restore: false });
  commit(clearSamples(state));
  $('#view-title').focus();
  toast(`Removed ${n} sample guest${n === 1 ? '' : 's'}.`);
}

/* ---------------------------------------------------------------- */
/* Add guest dialog                                                  */
/* ---------------------------------------------------------------- */

function openAddDialog() {
  addForm.reset();
  $('#add-error').hidden = true;
  for (const el of [addForm.elements.name, addForm.elements.email]) {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  }
  addForm.elements.stage.value = 'outreach';
  if (typeof addDialog.showModal === 'function') addDialog.showModal();
  else addDialog.setAttribute('open', '');
  addForm.elements.name.focus();
}

function closeAddDialog() {
  if (typeof addDialog.close === 'function') addDialog.close();
  else addDialog.removeAttribute('open');
}

function initAddDialog() {
  addForm.elements.stage.replaceChildren(...STAGES.map((s) => h('option', { value: s.id }, s.label)));
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = addForm.elements;
    const name = f.name.value.trim();
    const email = f.email.value.trim();
    const err = $('#add-error');
    for (const el of [f.name, f.email]) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    }
    const bad = !name ? [f.name, 'Enter the guest’s name.'] : email && !isValidEmail(email) ? [f.email, 'Enter a valid email address, like name@example.com, or leave it empty.'] : null;
    if (bad) {
      err.textContent = bad[1];
      err.hidden = false;
      bad[0].setAttribute('aria-invalid', 'true');
      bad[0].setAttribute('aria-describedby', 'add-error');
      bad[0].focus();
      return;
    }
    err.hidden = true;
    const p = parseLocal(f.recordingAt.value);
    const guest = createGuest({
      name,
      role: f.role.value.trim(),
      topic: f.topic.value.trim(),
      email,
      stage: f.stage.value,
      recordingAt: p && p.hasTime ? toLocalString(p) : ''
    });
    if (ui.query && filterGuests([guest], ui.query).length === 0) {
      ui.query = '';
      search.value = '';
    }
    saveGuest(guest);
    closeAddDialog();
    openGuest(guest.id);
    toast(`Added ${guest.name} to ${getStage(guest.stage).label}.`);
  });
  addDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-add"]')) closeAddDialog();
  });
}

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

function init() {
  initBoard();
  initPanel();
  initGuests();
  initCalendar();
  initTemplates();
  initSettings();
  initPlan();
  initAddDialog();

  search.addEventListener('input', () => {
    ui.query = search.value;
    renderMain();
    announceSearch();
  });

  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'add-guest') openAddDialog();
    else if (action === 'clear-samples') clearSampleData();
    else if (action === 'download-raw') downloadRaw();
    else if (action === 'check-submissions') checkSubmissions();
    else if (action === 'start-fresh') startFreshFromUnreadable();
  });

  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { focus: true }));

  // Pick up guests saved from the intake form in another tab.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || unreadableData()) return;
    const fresh = loadStoredState();
    if (!fresh) return;
    state = fresh;
    renderChrome();
    renderMain();
    if (ui.selectedId) {
      if (findGuest(ui.selectedId)) renderPanel();
      else closePanel({ restore: false });
    }
  });

  renderChrome();
  setView(location.hash.slice(1) || 'pipeline');
  syncHeadCheck();
  if (backendReady() && sync.autoCheck && !unreadableData()) checkSubmissions({ quiet: true });
}

init();

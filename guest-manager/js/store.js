// Browser storage wrapper. Every localStorage access is guarded because it can
// throw (private mode, blocked site data, quota). When storage is unavailable
// the app keeps working in memory for the current visit.
import { STORAGE_KEY, createInitialState, parseState, serializeState, defaultId, nowInZone } from './logic.js';

let storageOk = true;

export function storageAvailable() {
  return storageOk;
}

function read() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    storageOk = false;
    return null;
  }
}

function write(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
    storageOk = true;
    return true;
  } catch {
    storageOk = false;
    return false;
  }
}

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * What is stored, without ever overwriting it:
 *   { status: 'empty' }                          nothing stored yet
 *   { status: 'ok', state }                      valid data
 *   { status: 'corrupt', raw, error }            something is stored but it can't be read
 *                                                (newer version, truncated JSON, ...)
 */
export function inspectStoredState() {
  const raw = read();
  if (raw == null || raw === '') return { status: 'empty' };
  try {
    return { status: 'ok', state: parseState(raw, { idFn: defaultId, timeZone: browserTimeZone() }) };
  } catch (err) {
    return { status: 'corrupt', raw, error: err.message };
  }
}

/** Stored state, or null if nothing (valid) is stored yet. Never writes. */
export function loadStoredState() {
  const r = inspectStoredState();
  return r.status === 'ok' ? r.state : null;
}

/*
 * Unreadable stored data is never overwritten. It is copied to a
 * "…:corrupt-<timestamp>" backup key, and saving is switched off for this
 * visit so the app runs in memory until the person decides what to do.
 */
let unreadable = null; // { raw, error, backupKey }

export function unreadableData() {
  return unreadable;
}

function backupCorrupt(raw, error) {
  let backupKey = '';
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(corruptPrefix()) && window.localStorage.getItem(k) === raw) backupKey = k;
    }
    if (!backupKey) {
      backupKey = corruptPrefix() + new Date().toISOString().replace(/[:.]/g, '-');
      window.localStorage.setItem(backupKey, raw);
    }
  } catch {
    backupKey = ''; // quota or blocked storage: the original key is still untouched
  }
  unreadable = { raw, error, backupKey };
  return unreadable;
}

export function corruptPrefix() {
  return `${STORAGE_KEY}:corrupt-`;
}

/** Stored state, or a fresh state (with sample guests) saved on first run. */
export function loadState() {
  const r = inspectStoredState();
  if (r.status === 'ok') return r.state;
  const tz = browserTimeZone();
  const state = createInitialState({ timeZone: tz, today: nowInZone(tz).slice(0, 10) });
  if (r.status === 'corrupt') {
    console.warn('Guest manager: stored data could not be read. It was left untouched and backed up; working in memory.', r.error);
    backupCorrupt(r.raw, r.error);
    return state;
  }
  saveState(state);
  return state;
}

/**
 * Stop protecting unreadable data (after the person downloaded it and chose
 * to start fresh). The backup key is kept.
 */
export function releaseUnreadable() {
  unreadable = null;
}

/** Save, unless unreadable data is being protected (then returns false). */
export function saveState(state) {
  if (unreadable) return false;
  return write(serializeState(state));
}

export { STORAGE_KEY };

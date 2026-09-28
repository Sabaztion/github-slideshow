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

/** Stored state, or null if nothing (valid) is stored yet. */
export function loadStoredState() {
  const raw = read();
  if (!raw) return null;
  try {
    return parseState(raw, { idFn: defaultId, timeZone: browserTimeZone() });
  } catch (err) {
    console.warn('Guest manager: stored data could not be read, starting fresh.', err);
    return null;
  }
}

/** Stored state, or a fresh state (with sample guests) saved on first run. */
export function loadState() {
  const existing = loadStoredState();
  if (existing) return existing;
  const tz = browserTimeZone();
  const state = createInitialState({ timeZone: tz, today: nowInZone(tz).slice(0, 10) });
  saveState(state);
  return state;
}

export function saveState(state) {
  return write(serializeState(state));
}

export { STORAGE_KEY };

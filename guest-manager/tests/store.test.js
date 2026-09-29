// store.js with a fake localStorage: unreadable data must never be overwritten.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

globalThis.window = { localStorage: new FakeStorage() };
const store = await import('../js/store.js');
const { STORAGE_KEY } = store;

describe('store: unreadable data is protected', () => {
  beforeEach(() => {
    globalThis.window.localStorage = new FakeStorage();
    store.releaseUnreadable();
  });

  test('first run saves a fresh state', () => {
    const s = store.loadState();
    assert.ok(s.guests.length > 0);
    assert.ok(window.localStorage.getItem(STORAGE_KEY));
    assert.equal(store.unreadableData(), null);
  });

  for (const [label, raw] of [
    ['newer schema version', '{"app":"podcast-guest-manager","version":9,"guests":[]}'],
    ['truncated JSON', '{"app":"podcast-guest-manager","guests":[{"name":"A'],
    ['guests not an array', '{"app":"podcast-guest-manager","guests":{}}']
  ]) {
    test(`${label}: kept, backed up, and saving is refused`, () => {
      window.localStorage.setItem(STORAGE_KEY, raw);
      const s = store.loadState();
      assert.ok(s.guests.length > 0, 'runs in memory');
      assert.equal(window.localStorage.getItem(STORAGE_KEY), raw, 'original untouched');
      const bad = store.unreadableData();
      assert.ok(bad && bad.backupKey.startsWith(`${STORAGE_KEY}:corrupt-`));
      assert.equal(window.localStorage.getItem(bad.backupKey), raw);
      assert.equal(store.saveState(s), false);
      assert.equal(window.localStorage.getItem(STORAGE_KEY), raw, 'still untouched after a save attempt');
      assert.equal(store.inspectStoredState().status, 'corrupt');
      assert.equal(store.loadStoredState(), null);
    });
  }

  test('loading twice does not create a second backup', () => {
    window.localStorage.setItem(STORAGE_KEY, '{bad');
    store.loadState();
    store.releaseUnreadable();
    store.loadState();
    const backups = [...window.localStorage.map.keys()].filter((k) => k.includes(':corrupt-'));
    assert.equal(backups.length, 1);
  });

  test('after releaseUnreadable the person can save again', () => {
    window.localStorage.setItem(STORAGE_KEY, '{bad');
    const s = store.loadState();
    store.releaseUnreadable();
    assert.equal(store.saveState(s), true);
    assert.equal(store.inspectStoredState().status, 'ok');
  });
});

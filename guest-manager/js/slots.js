// Pure logic for the guest availability calendar: time zone conversion with
// Intl, week grids, and merging 30-minute slots into ranges. Slots are stored
// the same way as the rest of the app: naive "YYYY-MM-DDTHH:mm" strings that
// mean wall-clock time in the host time zone.
import { parseLocal, toLocalString, nowInZone, addDays, weekday, formatDay, formatTime, zonedToUtcMs, convertZone } from './logic.js';

export const SLOT_MINUTES = 30;
export const GRID_START_HOUR = 8;
export const GRID_END_HOUR = 20; // exclusive: the last row starts at 19:30
export const MAX_WEEKS_AHEAD = 4; // this week plus four more
export const MAX_FREE_SLOTS = 1000;

const MIN = 60 * 1000;

/** Naive local string -> minutes since the epoch, as if it were UTC. */
export function localToMinutes(str) {
  const p = parseLocal(str);
  if (!p) return NaN;
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) / MIN;
}

export function minutesToLocal(minutes) {
  const d = new Date(minutes * MIN);
  return toLocalString({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() });
}

export function addMinutes(str, n) {
  return minutesToLocal(localToMinutes(str) + n);
}

/** Wall-clock time in `timeZone` for a UTC instant (ms). */
export function utcToLocal(ms, timeZone) {
  return nowInZone(timeZone, new Date(ms));
}

/**
 * UTC instant (ms) for a wall-clock time in `timeZone`. For a time that does
 * not exist (skipped by a DST change) the result is an instant near the gap;
 * `localRoundTrips` tells the two cases apart.
 */
export function localToUtc(str, timeZone) {
  return zonedToUtcMs(str, timeZone);
}

export function localRoundTrips(str, timeZone) {
  const t = localToUtc(str, timeZone);
  return !Number.isNaN(t) && utcToLocal(t, timeZone) === toLocalString(parseLocal(str));
}

/** Convert a wall-clock slot from one zone to another (same instant). */
export const convertSlot = convertZone;

/** Monday on or before `ymd`. */
export function mondayOf(ymd) {
  const p = parseLocal(ymd);
  const back = (weekday(p) + 6) % 7;
  return addDays(ymd.slice(0, 10), -back);
}

/**
 * One week of cells in `timeZone`, Monday first. Each day has one cell per
 * 30 minutes from startHour to endHour. Every cell carries its UTC instant so
 * cells in different zones can be matched; `valid` is false for times that
 * don't exist that day (DST gap) and `past` is true before `nowMs`.
 */
export function weekGrid({ weekStart, timeZone, startHour = GRID_START_HOUR, endHour = GRID_END_HOUR, step = SLOT_MINUTES, nowMs = Date.now() }) {
  const days = [];
  const times = [];
  for (let m = startHour * 60; m < endHour * 60; m += step) times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  for (let i = 0; i < 7; i++) {
    const ymd = addDays(weekStart, i);
    const cells = times.map((t) => {
      const local = `${ymd}T${t}`;
      const utc = localToUtc(local, timeZone);
      return { local, utc, valid: localRoundTrips(local, timeZone), past: utc < nowMs };
    });
    days.push({ ymd, cells });
  }
  return { days, times };
}

/** Week start (Monday) for week `index` (0 = this week) in `timeZone`. */
export function weekStartFor(index, timeZone, nowMs = Date.now()) {
  const today = utcToLocal(nowMs, timeZone).slice(0, 10);
  return addDays(mondayOf(today), 7 * index);
}

/**
 * Merge slot starts into contiguous ranges: [{ start, end, slots }]. `end`
 * is the end of the last slot. Input order and duplicates don't matter.
 */
export function mergeRanges(slots, step = SLOT_MINUTES) {
  const mins = [...new Set((slots || []).map(localToMinutes).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b);
  const ranges = [];
  for (const m of mins) {
    const last = ranges[ranges.length - 1];
    if (last && m === last.endMin) {
      last.endMin = m + step;
      last.slots.push(minutesToLocal(m));
    } else {
      ranges.push({ startMin: m, endMin: m + step, slots: [minutesToLocal(m)] });
    }
  }
  return ranges.map((r) => ({ start: minutesToLocal(r.startMin), end: minutesToLocal(r.endMin), slots: r.slots }));
}

/** "Tue, Oct 6 · 2:00 PM – 4:00 PM" (the end may fall on the next day). */
export function formatRange(r) {
  const sameDay = r.start.slice(0, 10) === r.end.slice(0, 10) || r.end.slice(11) === '00:00';
  return `${formatDay(r.start)} · ${formatTime(r.start)} – ${sameDay ? '' : `${formatDay(r.end)} `}${formatTime(r.end)}`;
}

/** Plain-text summary of chosen ranges, for the copy / email fallback. */
export function availabilityToText({ showName, name, email, timeZone, guestTimeZone, slots, notes }) {
  const ranges = mergeRanges(slots);
  const lines = [`Availability for ${String(showName || '').trim() || 'the show'}`, '', `Name: ${name || ''}`, `Email: ${email || ''}`, '', `Free times (${timeZone}):`];
  if (ranges.length) for (const r of ranges) lines.push(`- ${formatRange(r)}`);
  else lines.push('- none picked');
  if (guestTimeZone && guestTimeZone !== timeZone) {
    lines.push('', `The same times in my time zone (${guestTimeZone}):`);
    const mine = mergeRanges(slots.map((s) => convertSlot(s, timeZone, guestTimeZone)));
    for (const r of mine) lines.push(`- ${formatRange(r)}`);
  }
  if (notes) lines.push('', 'Notes:', String(notes));
  return lines.join('\n');
}

/** Upcoming ranges only (ending after `nowLocal`), for the host's panel and calendar. */
export function upcomingRanges(slots, nowLocal) {
  const now = localToMinutes(nowLocal);
  return mergeRanges((slots || []).filter((s) => Number.isNaN(now) || localToMinutes(s) >= now));
}

/** Ranges that start on day `ymd`, for the calendar overlay. */
export function rangesByDay(slots) {
  const out = {};
  for (const r of mergeRanges(slots)) (out[r.start.slice(0, 10)] ||= []).push(r);
  return out;
}

// Shared browser helpers for the guest-facing pages (intake, availability,
// Q&A): toasts, copying, the "send to the show" status, and client-side
// photo resizing. Text is only ever set with textContent.
import { fitWithin, parseDataUrl, LIMITS } from './remote.js';
import { endpointHost } from './logic.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = message; });
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.textContent = ''; }, 4500);
}

/** Copy a textarea's text; falls back to selecting it for Ctrl+C. */
export async function copyTextarea(ta) {
  const text = ta.value;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  ta.focus();
  ta.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

/** Opened from a shared link (it has query params): hide "Back to pipeline". */
export function hideBackLinkWhenShared() {
  if (new URLSearchParams(window.location.search).toString() !== '') {
    const back = $('.back-link');
    if (back) back.hidden = true;
  }
}

/** Write a polite status message (role=status element). */
export function setStatus(el, text) {
  if (el) el.textContent = text;
}

/** Disable a submit button while sending, and say so. */
export function setBusy(button, busy, busyLabel = 'Sending…') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.dataset.label || button.textContent;
    button.textContent = busyLabel;
    button.setAttribute('aria-disabled', 'true');
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.removeAttribute('aria-disabled');
    button.disabled = false;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This photo format can’t be read by your browser.')); };
    img.src = url;
  });
}

/**
 * Resize a chosen photo in the browser to fit 1000 x 1000 px as a JPEG, and
 * lower the quality until it fits the backend's size limit. Resolves to
 * { name, type, data (base64) }.
 */
export async function resizeHeadshot(file, { max = 1000, maxBytes = LIMITS.headshotBytes } = {}) {
  const img = await loadImage(file);
  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, max);
  if (!width) throw new Error('This photo is empty.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; // transparent PNGs get a white background, not black
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  for (const q of [0.86, 0.78, 0.68, 0.56, 0.45]) {
    const parsed = parseDataUrl(canvas.toDataURL('image/jpeg', q));
    if (parsed && parsed.data.length * 0.75 <= maxBytes) {
      const base = String(file.name || 'headshot').replace(/\.[^.]+$/, '') || 'headshot';
      return { name: `${base}.jpg`, type: 'image/jpeg', data: parsed.data };
    }
  }
  throw new Error('This photo is too large even after resizing.');
}

/** Tell the guest where "Send" goes: the host name of the web app from the link. */
export function deliveryNote(what, showName, endpoint) {
  const host = endpointHost(endpoint);
  return `${what} will be sent to a Google Apps Script web app at ${host}, which ${showName} uses to collect them in its Google Sheet.`;
}

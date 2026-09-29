// Network calls to the host's Google Apps Script web app (backend/Code.gs).
// POSTs use Content-Type text/plain so the browser sends a "simple" request
// with no CORS preflight (Apps Script can't answer preflights).
import { normalizeEndpoint } from './logic.js';
import { parseListResponse, listUrl } from './remote.js';

const TIMEOUT_MS = 30000;

async function fetchJson(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, { ...init, credentials: 'omit', redirect: 'follow', signal: ctrl?.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('The request timed out. Check your connection and try again.');
    throw new Error('Could not reach the server. Check your connection and try again.');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`The server answered with an error (HTTP ${res.status}).`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // A deployment that needs sign-in returns an HTML login page instead of JSON.
    throw new Error('The server did not return JSON. Is the web app deployed with access set to “Anyone”?');
  }
}

/** Send a guest submission. Resolves to { ok: true, id } or throws an Error with a readable message. */
export async function postSubmission(endpoint, payload) {
  const url = normalizeEndpoint(endpoint);
  if (!url) throw new Error('No valid endpoint is set up.');
  const json = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!json || json.ok !== true) throw new Error(String(json?.error || 'The server did not accept the submission.'));
  return json;
}

/** Health check: GET the endpoint with no parameters. */
export async function checkHealth(endpoint) {
  const url = normalizeEndpoint(endpoint);
  if (!url) throw new Error('Enter the web app URL first (it starts with https://).');
  const json = await fetchJson(url, { method: 'GET' });
  if (!json || json.ok !== true || json.service !== 'guest-intake') throw new Error('The URL answered, but it is not the guest intake web app.');
  return json;
}

/** List submissions since `since`. Resolves to parseListResponse's result. */
export async function fetchSubmissions(endpoint, readKey, since) {
  const url = listUrl(endpoint, readKey, since);
  if (!url) return { ok: false, error: 'Enter the web app URL first (it starts with https://).' };
  if (!readKey) return { ok: false, keyRejected: true, error: 'Enter the read key first.' };
  return parseListResponse(await fetchJson(url, { method: 'GET' }));
}

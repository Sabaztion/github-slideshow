# App idea prototypes

Six standalone, self-contained HTML prototypes — open any of them directly in a
browser, no server or install needed — plus a build-plan reference doc.

| File | What it is |
|---|---|
| `build-plans.html` | Data model, screens, backend needs, and stack recommendation for each app below |
| `momentum.html` | Context-aware day planner — surfaces what matters right now |
| `keystone.html` | Home maintenance / warranty / document tracker |
| `tideline.html` | Budgeting for irregular gig income |
| `polyglot.html` | "Relay" — translates one phrase into 3+ languages at once |
| `salah.html` | "Miqat" — daily Islamic prayer times, Hijri date, streak tracker |
| `commons.html` | Hyperlocal neighborhood board (offer / need / event posts) |

Each file saves your edits to that browser's local storage, so changes persist
across reloads but stay on that one device/browser — there's no shared backend.

## Testing

`tests/run-tests.js` is a Playwright suite covering the core interactions of all
six apps (add/edit/delete flows, filters, settings) plus regression tests for a
stored-XSS issue that was found and fixed (user-typed text — task names, post
titles/replies, etc. — is now HTML-escaped before being inserted into the DOM).

```
cd app-prototypes/tests
npm install
node run-tests.js
```

`tests/screenshot-all.js` renders each app in a headless browser and saves a
screenshot to `tests/screenshots/` for a quick visual check.

## Status

These are prototypes, not production apps: settings/calculations that require
real external data (prayer-time astronomy, live translation, bank data) are
mocked and clearly labeled as such in the UI. See `build-plans.html` for what
each would take to build for real.

# Podcast Guest Manager

A small, self-contained web app for running a podcast's guest pipeline, from first pitch to published episode. It is plain HTML, CSS and JavaScript ES modules: no framework, no build step, no npm dependencies. It is served as static files from this folder, so on GitHub Pages it lives at `/guest-manager/`.

## What it does

- **Pipeline board.** Five stages: Outreach, Booked, Recorded, Editing, Published. Cards show name, role, topic, recording time and prep progress. Drag a card to another column, or use its "Move to …" button (keyboard and touch friendly). On narrow screens the board scrolls sideways.
- **Guest details panel.** Click a card to edit every field: name, pronouns, role, topic, email, website or social, recording date and time, episode number and link, bio and notes. It also has the prep checklist (pre-interview call, bio and headshot received, mic and recording guide sent, release form signed, promo assets sent), a stage picker and a delete button. Changes save as you type. Press Esc to close.
- **Add guest and search.** "Add guest" opens a short form. The search box filters the board and the table by name, topic or role.
- **All guests.** A table you can sort by name, stage or recording date.
- **Recording calendar.** A month grid of scheduled recordings, colored by stage. Click one to open the guest. On phones it becomes an agenda list.
- **Email templates.** Editable Invitation, Booking confirmation, Recording reminder and Thank-you + episode link templates. They use these placeholders:
  - `{{guest_name}}`
  - `{{recording_time}}` (formatted, with the host time zone)
  - `{{show_name}}`
  - `{{episode_link}}`
  - `{{availability_link}}` (a guest's personal availability calendar link)
  - `{{qa_link}}` (a guest's personal pre-interview questions link)

  From a guest's panel, pick a template to see it filled in. Then use **Open in email app** (a prefilled `mailto:` link) or **Copy email**.
- **Guest intake form** (`intake.html`). Guests enter their details, pick recording times, upload a headshot, choose a recording setup and agree to the release. With the backend connected, answers reach you directly (see below).
- **Settings.** Show name, host time zone (used for recording times, templates and the intake form), optional host email, the times offered on the intake form, and a shareable intake link.
- **Sample data.** On first run a few guests marked "Sample" are added so there is something to explore. **Clear sample data** (on the banner or in Settings) removes only those.

## Availability calendar

`availability.html` is a guest-facing week grid (Monday to Sunday, 30-minute rows from 8 AM to 8 PM) where guests mark when they're free:

- **Paint times** by clicking, or pressing and dragging with a mouse. On touch screens a tap toggles one half hour. With a keyboard the grid is a set of real buttons (`aria-pressed`): the arrow keys, Home/End and Page Up/Down move, and Space or Enter marks a half hour. Past times are greyed out.
- **Two time zones.** Times start in the show's time zone. When the guest's browser is in another zone, a switch shows the grid in their own zone instead. Marks are kept as exact instants, so they line up in both views. The guest can look up to four weeks ahead, clear a week, and see a summary of merged ranges.
- **Sending.** With an endpoint it posts `type: "availability"` to the same Apps Script (stored in the `Availability` sheet). Without one, or if sending fails, it offers copy / email like the intake form.
- **Links.** Settings has a general availability link. Each guest's panel has **Copy availability link** (it pre-fills that guest's id, name and email) and **Email availability request**, which uses the new *Availability request* template and its `{{availability_link}}` placeholder. The intake form links to the calendar too ("Pick your times on a calendar").
- **On the host side**, "Check for new submissions" imports availability into the matching guest (by guest id, then email, else a new Outreach guest), converted to the host's time zone. The latest calendar replaces earlier free times. The guest panel lists upcoming ranges; pick a start time and press **Book** to set the recording time (an Outreach guest moves to Booked). The Recording calendar can overlay one guest's free times ("Show availability for").

## Episode plan and guest Q&A

The **Episode plans** page in the sidebar lists every guest's plan, with plans in progress first. Each guest's panel has **Open episode plan** (`#plan/<guest id>`), a full-width view with:

- **Episode:** working title and angle / summary.
- **Talking points:** an ordered list you can add to, edit, reorder (↑ ↓) and delete, with optional minutes per point and a running total.
- **Questions to ask on air:** a separate list you draft for the interview.
- **Questions for the guest:** a pre-interview questionnaire. It starts from the reusable **Q&A question bank** in Settings (one question per line, up to 20), and you can edit, reorder, delete or add custom questions per guest. **Copy Q&A link** and **Email the questions** (the *Pre-interview questions* template with `{{qa_link}}`) save the questions and mark the Q&A as sent. Received answers show under each question with the date answered, and **→ Talking point** / **→ On-air question** copy an answer into the plan in one click. Topics the guest suggested are shown too.
- **Print run sheet** opens the print dialog with a clean printable page (print CSS): title, guest and recording time, angle, intro/bio, talking points with timings, on-air questions and the guest's answers. **Download run sheet (.txt)** saves the same content as text.

Pipeline cards and the panel show the Q&A status: *Q&A sent* or *Q&A answered* (cards stay quiet while it's not sent). A separate "Q&A answered" prep checklist item was not added: it would change the existing five-step progress on every card, and the status chip already shows it.

**The guest page** (`qa.html`) is opened from the share link, which carries the show name, the guest's id, name and email, the endpoint and the questions as compact URL-safe base64 JSON. Links are capped at 20 questions of up to 300 characters and about 3,000 characters of encoded questions; if some don't fit, the plan view warns you how many were left out. Guests answer in labelled text areas with a character counter (2,000 characters each), can add "Topics I'd love to talk about", and their draft autosaves in their browser until it's sent. Answers go to the Apps Script endpoint as `type: "qa"` (the `QA` sheet), with the same copy / email fallback. "Check for new submissions" imports them into the matching guest (by id, then email); re-importing never duplicates, and for each question the latest answer wins and keeps its answered-at time.

## Where your data lives

Everything is stored in your browser's `localStorage` under the key `podcast-guest-manager:v1`. Nothing is sent anywhere unless you connect the optional backend below (then only guest pages send their answers to your own Google Sheet). That means:

- Data is per browser and per device. Another browser, or a private window, starts empty.
- Clearing site data deletes it. Use **Settings → Export JSON** regularly for a backup, and **Import JSON** to restore it or move it to another browser. Import replaces the current data after asking you first.
- If storage is blocked, the app still works for the current visit and warns you that changes won't be kept.
- If the stored data exists but can't be read (for example it was written by a newer version, or got truncated), it is **never overwritten**. The app copies it to a backup key (`podcast-guest-manager:v1:corrupt-<timestamp>`), shows a warning banner with **Download raw data**, and runs on sample data in memory without saving. **Start fresh** turns saving back on (the backup key stays). The intake form also refuses to save into an unreadable guest list; guests can still copy or email their answers.
- **On GitHub Pages, storage is shared by every site on the same origin.** Every project site under `https://<user>.github.io/` shares one `localStorage`, so any other page published there can read this app's data. For real guest data, serve the app from its own origin: a custom domain or subdomain (for example `guests.example.com`), or at least a GitHub account/organization whose `github.io` site hosts nothing else.

## Connect the intake form (free Google Sheet backend)

Without a backend, a guest's answers stay in their own browser. The app ships a small [Google Apps Script](https://developers.google.com/apps-script) web app, `backend/Code.gs`, that stores submissions in a Google Sheet you own. It costs nothing and needs no server, build step or npm packages.

1. **Create a Sheet.** Go to [sheets.new](https://sheets.new) and name it, for example "Guest intake".
2. **Paste the code.** In the Sheet, open **Extensions → Apps Script**. Delete the sample code, paste all of `guest-manager/backend/Code.gs`, set `SHOW_NAME` near the top, and save.
3. **Run `setup()`.** Pick `setup` in the function menu and press **Run**. Approve the permissions (Sheets, and Drive for headshots). It creates the `Submissions`, `Availability` and `QA` sheets, a Drive folder called "*Show name* guest headshots", and a random **read key**.
4. **Copy the read key.** Open **Executions** (or View → Logs) and copy the key that `setup()` logged. It is stored in **Project Settings → Script Properties** as `READ_KEY`, so you can also copy it from there or set your own there (at least 16 characters).
5. **Deploy.** **Deploy → New deployment**, type **Web app**, *Execute as:* **Me**, *Who has access:* **Anyone**. Copy the web app URL (`https://script.google.com/macros/s/…/exec`).
6. **Connect the app.** In the guest manager go to **Settings → Intake backend**, paste the URL into **Intake endpoint URL** and the key into **Read key**, then press **Test connection**.
7. **Share the link.** **Settings → Guest intake form → Copy link.** The link now includes your endpoint URL (never the key), so the form posts answers to your Sheet.
8. **Import.** Press **Check for new submissions** (on the pipeline header or in Settings). New guests land in **Outreach** with their offered times, bio, links, headshot link and notes. A submission from someone already on your list (same email) is merged into that guest instead of creating a duplicate, and checking twice never imports the same submission twice. With "Check when the app opens" ticked this happens automatically.

Optional: add a Script Property `NOTIFY_EMAIL` to get an email for each new submission. After editing `Code.gs`, publish it with **Deploy → Manage deployments → Edit → Version: New version** (the URL stays the same).

**How guest pages send.** The form POSTs JSON with `Content-Type: text/plain`, which avoids a CORS preflight that Apps Script can't answer. A chosen headshot is resized in the browser to at most 1000 × 1000 px JPEG and sent with the answers (1.5 MB at most); the script saves it to the Drive folder, private to you, and stores its link. If there is no endpoint or sending fails, the form says so, keeps a **Try sending again** button, and falls back to the old behavior: it saves the answers in that browser and offers **Copy as text** and **Open in email app**.

### Security notes

- **The endpoint is public for writes.** Anyone with the URL can submit, which is what lets guests reach you. The script validates every field (control characters are stripped from single-line fields), limits lengths and the total size, rate-limits each email address (5 per 10 minutes) and all submissions (30 per minute), and has **daily caps**: 200 submissions, 100 headshots and 20 notification emails a day (the last email says notifications are paused; submissions are still saved). The limits are checked inside the script lock, so parallel requests can't slip past them. The hidden honeypot field silently drops most bots. Photos must really be JPEG, PNG or WebP (the file's first bytes are checked, not just its claimed type).
- **Nothing gets converted.** Every column except `submittedAt` is formatted as plain text and rows are written with `setValues`, so Sheets never turns "3/4", "TRUE", "0012" or a slot time into a date or number. Text that starts with `=`, `+`, `-` or `@` is also stored so it can't run as a formula. Sheets created by an older version of the script get the new columns (`token`, `slotsUtc`) added automatically by `setup()` or the next submission.
- **Guests' personal links carry a secret token.** Availability and Q&A links from a guest's panel include a random per-guest token (`t=…`), never the guest id. A submission with the right token merges into that guest. One that only matches an existing guest's email or id (for example from the general intake link, or someone who knows the address) is **not** merged: it waits under **Needs review** in the guest's panel with **Accept** and **Discard**, and the import summary says so. A submission can record consent to the release but never clear it.
- **Only Apps Script endpoints.** The app and the guest pages only accept `https://script.google.com/macros/s/…/exec` as an endpoint (plus `localhost` for development), so a crafted share link can't send guests' answers to another site. Guest pages name the host their answers go to.
- **Reading needs the read key, and it only goes where you entered it.** `GET ?action=list&key=…` only returns data when the key matches `READ_KEY`; otherwise the endpoint answers `{"ok":true,"service":"guest-intake"}`. The key stays in this browser (a separate storage key, not included in Export JSON) and is tied to the endpoint it was entered for. If the endpoint changes, including by importing a backup (the app asks before accepting a backup's endpoint and shows its host), the key isn't sent until you paste it again. It travels in the list request's URL over HTTPS, so treat it like a password. Listing reads only rows newer than the last check (at most 1,000 per sheet).
- **Server-side identity.** The show name and the notification address come from the script's own settings, never from the request.
- **Rotate the key** if it leaks: run `rotateReadKey()` in Apps Script (the old key stops working at once) and paste the new key into Settings. To cut off writes too, archive the deployment and create a new one, then share the new link.
- Only `http(s)` values ever become links in the app, and all guest text is rendered as text, never as HTML.

## Time zones

Recording times are entered and stored as wall-clock times in the host time zone (Settings). Templates show them with the zone name, for example `Tue Oct 6 · 2:00 PM (Europe/Berlin)`. If you change the host time zone, stored times are not converted.

## Running it locally

ES modules do not load from `file://` URLs, so serve the folder over HTTP. From the repository root:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/guest-manager/
```

Any static file server works.

## Tests

The pure logic (stage transitions, checklist progress, template rendering and `mailto:` building, sorting and filtering, date grouping and the month grid, storage serialization and import validation, intake conversion) lives in `js/logic.js`, with the backend, availability and episode-plan logic in `js/remote.js`, `js/slots.js` and `js/plan.js`. `tests/backend.test.js` loads `backend/Code.gs` in a Node `vm` with stubbed Apps Script services to test its validation, honeypot, rate limit, storage and read-key check. Everything is covered by unit tests that use Node's built-in test runner, with no packages needed:

```sh
node --test guest-manager/tests/
```

This needs Node 18 or later. On Node 22 a directory argument loads `tests/index.js`, which imports every suite. `node --test guest-manager/tests/*.test.js` works too.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The app: pipeline, calendar, table, templates, settings |
| `intake.html` | Guest intake form |
| `availability.html` | Guest availability calendar |
| `qa.html` | Guest pre-interview questions |
| `js/qa.js` | Q&A page UI |
| `js/availability.js` | Availability calendar UI |
| `css/styles.css` | Shared styles (Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono via Google Fonts) |
| `js/logic.js` | Pure logic, no DOM or storage access |
| `js/store.js` | `localStorage` wrapper (every access guarded) |
| `js/app.js` | Main app UI |
| `js/intake.js` | Intake form UI |
| `js/guest-page.js` | Shared helpers for guest pages (status, copy, photo resizing) |
| `js/remote.js` | Pure logic for the backend: payloads, validation, importing and merging submissions |
| `js/api.js` | `fetch` calls to the Apps Script web app |
| `js/slots.js` | Pure availability logic: time zones, week grid, ranges |
| `js/plan.js` | Pure episode plan and Q&A logic |
| `backend/Code.gs` | Google Apps Script backend (not published with the site) |
| `tests/` | `node:test` unit tests |

## Accessibility

The app uses real buttons, links and labels throughout. Every control is keyboard usable with a visible focus ring, and targets are at least 44 px. Text contrast is at least 4.5:1 and form control borders at least 3:1. The board has a Move button as an alternative to dragging. Sortable table headers expose `aria-sort`. When the details panel is a slide-over sheet on narrower screens it is announced as a modal dialog (`role="dialog"`, `aria-modal`), and the rest of the page, including the skip link, is made inert; toasts move above the panel's footer and never block taps. Search results are announced through a polite status message once typing pauses. The stage picker in the panel only moves a guest when you press Enter or leave it after using the arrow keys. Email and link fields get a gentle inline check. Intake guests who didn't agree to the release are flagged with a "No release" tag on their card and panel. On the intake form each time is also shown in the guest's own time zone. Busy buttons (sending, checking) use `aria-disabled` and `aria-busy` instead of `disabled`, so keyboard focus never falls off them; the same goes for the week arrows on the availability page and the ↑ ↓ buttons in the episode plan (which announce "Moved to position N of M"). Closing the guest panel returns focus to whatever opened it. Guest pages link each error in the error summary to its field (the availability error links to the grid). On the availability grid, marked cells get a white focus ring, hour rules have 3:1 contrast and passed times are clearly hatched. Printing from the Episode plan (the button or Ctrl+P) prints the run sheet; other views print normally.

## Jekyll / GitHub Pages note

This repository is a Jekyll site. Jekyll copies files without front matter (all the HTML, CSS and JS here) to the built site verbatim, so Liquid never touches the `{{…}}` template placeholders in the JavaScript. This was checked with a local `jekyll build`: every app file came out byte-for-byte identical. `_config.yml` also excludes `guest-manager/README.md`, `guest-manager/tests` and `guest-manager/backend` from the published site. They aren't needed at runtime, and excluding them means no Markdown with placeholders ever goes through Liquid.

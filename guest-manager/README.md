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

  From a guest's panel, pick a template to see it filled in. Then use **Open in email app** (a prefilled `mailto:` link) or **Copy email**.
- **Guest intake form** (`intake.html`). Guests enter their details, pick recording times, choose a recording setup and agree to the release. See the limitation below.
- **Settings.** Show name, host time zone (used for recording times, templates and the intake form), optional host email, the times offered on the intake form, and a shareable intake link.
- **Sample data.** On first run a few guests marked "Sample" are added so there is something to explore. **Clear sample data** (on the banner or in Settings) removes only those.

## Where your data lives

Everything is stored in your browser's `localStorage` under the key `podcast-guest-manager:v1`. Nothing is sent anywhere. That means:

- Data is per browser and per device. Another browser, or a private window, starts empty.
- Clearing site data deletes it. Use **Settings → Export JSON** regularly for a backup, and **Import JSON** to restore it or move it to another browser. Import replaces the current data after asking you first.
- If storage is blocked, the app still works for the current visit and warns you that changes won't be kept.
- If the stored data exists but can't be read (for example it was written by a newer version, or got truncated), it is **never overwritten**. The app copies it to a backup key (`podcast-guest-manager:v1:corrupt-<timestamp>`), shows a warning banner with **Download raw data**, and runs on sample data in memory without saving. **Start fresh** turns saving back on (the backup key stays). The intake form also refuses to save into an unreadable guest list; guests can still copy or email their answers.
- **On GitHub Pages, storage is shared by every site on the same origin.** Every project site under `https://<user>.github.io/` shares one `localStorage`, so any other page published there can read this app's data. For real guest data, serve the app from its own origin: a custom domain or subdomain (for example `guests.example.com`), or at least a GitHub account/organization whose `github.io` site hosts nothing else.

## The intake form has no backend

There is no server, so **a guest's submission does not reach you automatically.** When the form is submitted:

1. The guest is saved into **this browser's** guest list (in the Outreach column, with the offered times, bio, setup and notes). This is useful when the host fills in the form with the guest, for example on a call, or when testing.
2. The form shows the answers as plain text with **Copy as text** and **Open in email app** buttons. A remote guest on their own device must send those answers to you by email. If you set a host email in Settings and share the link from Settings, **Open in email app** is addressed to you.

The headshot upload keeps only the file name. Guests are asked to attach the photo to their email.

**Sharing the form.** Settings → Guest intake form → **Copy link** gives a URL like `intake.html?show=…&tz=…&to=…&slots=…`. It carries your show name, time zone, email and offered times, so a remote guest sees the right details even though their browser has none of your data. Times are shown in the host's time zone, and the form says which one.

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

The pure logic (stage transitions, checklist progress, template rendering and `mailto:` building, sorting and filtering, date grouping and the month grid, storage serialization and import validation, intake conversion) lives in `js/logic.js`. It is covered by unit tests that use Node's built-in test runner, with no packages needed:

```sh
node --test guest-manager/tests/
```

This needs Node 18 or later. On Node 22 a directory argument loads `tests/index.js`, which imports every suite. `node --test guest-manager/tests/*.test.js` works too.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The app: pipeline, calendar, table, templates, settings |
| `intake.html` | Guest intake form |
| `css/styles.css` | Shared styles (Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono via Google Fonts) |
| `js/logic.js` | Pure logic, no DOM or storage access |
| `js/store.js` | `localStorage` wrapper (every access guarded) |
| `js/app.js` | Main app UI |
| `js/intake.js` | Intake form UI |
| `tests/` | `node:test` unit tests |

## Accessibility

The app uses real buttons, links and labels throughout. Every control is keyboard usable with a visible focus ring, and targets are at least 44 px. Text contrast is at least 4.5:1 and form control borders at least 3:1. The board has a Move button as an alternative to dragging. Sortable table headers expose `aria-sort`. When the details panel is a slide-over sheet on narrower screens it is announced as a modal dialog (`role="dialog"`, `aria-modal`), and the rest of the page, including the skip link, is made inert; toasts move above the panel's footer and never block taps. Search results are announced through a polite status message once typing pauses. The stage picker in the panel only moves a guest when you press Enter or leave it after using the arrow keys. Email and link fields get a gentle inline check. Intake guests who didn't agree to the release are flagged with a "No release" tag on their card and panel. On the intake form each time is also shown in the guest's own time zone.

## Jekyll / GitHub Pages note

This repository is a Jekyll site. Jekyll copies files without front matter (all the HTML, CSS and JS here) to the built site verbatim, so Liquid never touches the `{{…}}` template placeholders in the JavaScript. This was checked with a local `jekyll build`: every app file came out byte-for-byte identical. `_config.yml` also excludes `guest-manager/README.md` and `guest-manager/tests` from the published site. They aren't needed at runtime, and excluding them means no Markdown with placeholders ever goes through Liquid.

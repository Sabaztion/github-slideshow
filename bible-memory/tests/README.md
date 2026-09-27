# Verse Buddies tests

Automated checks that the app works and the lessons are accurate. They run on
GitHub automatically (`.github/workflows/verse-buddies-tests.yml`) whenever
anything in `bible-memory/` changes.

## Run them yourself

```sh
npm install --no-save playwright
npx playwright install chromium
node bible-memory/tests/run-tests.js
```

- `KJV_JSON=path/to/en_kjv.json` also checks every verse word for word against the
  King James text ([download](https://raw.githubusercontent.com/thiagobodruk/bible/master/json/en_kjv.json)).
  Without it that one test is skipped.
- `TEST_FILTER="build it"` runs only tests whose name matches.

## What is checked

| Area | Checks |
|---|---|
| Verses | 52 verses, no duplicates, references well formed, text clean, **matches KJV word for word** |
| Lessons | Every verse has a full lesson (meaning, words to know, talk question, quiz, challenge, prayer) |
| Lesson accuracy | Every "word to know" really appears in its verse; fill-in-the-blank quizzes match the verse; quiz answers match `answer-key.json` |
| Home | 52 tiles, Verse of the Week (changes weekly, cycles all 52), topic filters, progress bar |
| Lesson screen | All parts shown for all 52 verses; quiz wrong/right colors, messages and locking |
| Games | Read shows exact text; Hide Words (quarter start, Hide more, slider, peek, keyboard); First Letters (correct letter for every word, reveal by tap/keyboard); Build It completed for **all 52 verses**, wrong taps, hint, start over, repeated words |
| Stars | 1 star per win, trophy at 3, never more than 3, progress and topic counts |
| Saving | Survives reload; corrupted save data; storage blocked (private browsing) |
| Add my own verse | Limits, cancel, empty/whitespace rejected, spaces tidied, "My Verses", general lesson, all games, typed HTML/script shown as text and never run |
| Listen | Reads verse + reference slowly; "Not available" when the device can't speak |
| Layout | No sideways scrolling at 320, 360, 390, 768, 1280 px on every screen; dark mode; title, language, labeled buttons, keyboard reachable |

## If you change a quiz on purpose

Update the matching entry in `answer-key.json`. That file is the reviewed list of
correct answers, so a quiz answer can't change by accident.

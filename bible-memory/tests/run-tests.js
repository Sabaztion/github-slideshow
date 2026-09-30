#!/usr/bin/env node
/*
 * Automated tests for Verse Buddies (bible-memory/index.html).
 *
 *   node bible-memory/tests/run-tests.js
 *   TEST_FILTER="build it" node bible-memory/tests/run-tests.js   # run only matching tests
 *
 * Needs Playwright with Chromium. Set KJV_JSON to a KJV Bible JSON file
 * (format of github.com/thiagobodruk/bible, en_kjv.json) to also check every
 * verse word for word against the King James text.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const APP = "file://" + path.resolve(__dirname, "..", "index.html");

// ---------- tiny test harness ----------
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg ? msg + ": " : "") + "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

let browser;
async function openApp(opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 390, height: 844 },
    colorScheme: opts.colorScheme || "light"
  });
  if (opts.init) await context.addInitScript(opts.init);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(APP);
  // Fonts come from Google Fonts; a failed font load offline isn't an app error.
  page.appErrors = () => errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(e));
  return { page, context };
}
const data = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.VerseBuddiesData)));
const words = (t) => t.trim().split(/\s+/);

async function openVerse(page, ref) {
  await page.locator(".verse-tile", { has: page.locator(".ref", { hasText: new RegExp("^" + ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) }).first().click();
  await page.waitForSelector("#practice:not(.hidden)");
}

// Plays Build It the way a child would: tapping the chip whose word comes next.
async function buildCorrectly(page, text) {
  for (const w of words(text)) {
    const chip = page.locator(".chip:not(.used)", { hasText: w }).filter({ hasText: new RegExp("^" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }).first();
    await chip.click();
  }
  await page.waitForSelector(".celebrate");
}

// =====================================================================
// 1. CONTENT: verses and lessons
// =====================================================================
test("content: 52 verses, unique ids and references", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  eq(d.verses.length, 52, "verse count");
  eq(new Set(d.verses.map((v) => v.id)).size, 52, "unique ids");
  eq(new Set(d.verses.map((v) => v.ref)).size, 52, "unique refs");
  await context.close();
});

test("content: references are well formed", async () => {
  const { page, context } = await openApp();
  for (const v of (await data(page)).verses) {
    assert(/^(\d )?[A-Z][a-z]+ \d+:\d+(-\d+)?$/.test(v.ref), "bad ref: " + v.ref);
  }
  await context.close();
});

test("content: every verse belongs to a real topic and every topic has verses", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  const ids = new Set(d.topics.map((t) => t.id));
  for (const v of d.verses) assert(ids.has(v.topic), v.ref + " has unknown topic " + v.topic);
  for (const t of d.topics) assert(d.verses.some((v) => v.topic === t.id), "empty topic " + t.id);
  await context.close();
});

test("content: verse text is clean (no double spaces, ends with punctuation)", async () => {
  const { page, context } = await openApp();
  for (const v of (await data(page)).verses) {
    assert(v.text === v.text.trim(), v.ref + " has leading/trailing space");
    assert(!/\s{2,}/.test(v.text), v.ref + " has double spaces");
    assert(/[.;:?!]$/.test(v.text), v.ref + " does not end with punctuation");
  }
  await context.close();
});

test("content: every verse has a complete lesson, and no orphan lessons", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  const ids = new Set(d.verses.map((v) => v.id));
  for (const key of Object.keys(d.lessons)) assert(ids.has(key), "lesson for unknown verse " + key);
  for (const v of d.verses) {
    const L = d.lessons[v.id];
    assert(L, "missing lesson for " + v.ref);
    for (const f of ["big", "meaning", "talk", "doIt", "prayer"]) {
      assert(typeof L[f] === "string" && L[f].trim().length > 10, v.ref + " lesson." + f + " is empty/too short");
    }
    assert(/\?$/.test(L.talk.trim()), v.ref + " talk question should end with '?'");
    assert(/^Dear (God|Jesus)/.test(L.prayer) && /Amen\.$/.test(L.prayer), v.ref + " prayer should start 'Dear God/Jesus' and end 'Amen.'");
    assert(Array.isArray(L.words) && L.words.length >= 1, v.ref + " needs at least one word to know");
  }
  await context.close();
});

test("content: every quiz has 3 distinct options and a valid answer", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  for (const v of d.verses) {
    const q = d.lessons[v.id].quiz;
    assert(q && q.q.trim(), v.ref + " missing quiz");
    eq(q.options.length, 3, v.ref + " option count");
    eq(new Set(q.options.map((o) => o.toLowerCase())).size, 3, v.ref + " duplicate options");
    assert(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 3, v.ref + " bad answer index");
  }
  await context.close();
});

test("lesson alignment: quiz answers match the reviewed answer key", async () => {
  // answer-key.json was checked by a person. If you change a quiz on purpose, update the key too.
  const key = JSON.parse(fs.readFileSync(path.join(__dirname, "answer-key.json"), "utf8"));
  const { page, context } = await openApp();
  const d = await data(page);
  eq(Object.keys(key).length, d.verses.length, "answer key covers every verse");
  for (const v of d.verses) {
    const q = d.lessons[v.id].quiz;
    assert(key[v.ref], "no answer key entry for " + v.ref);
    eq(q.q, key[v.ref].question, v.ref + " question");
    eq(q.options[q.answer], key[v.ref].answer, v.ref + " correct answer");
  }
  await context.close();
});

test("lesson alignment: every 'word to know' actually appears in its verse", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  const problems = [];
  for (const v of d.verses) {
    for (const [term, meaning] of d.lessons[v.id].words) {
      // Whole words only, so "ye" can't pass by matching inside "yet".
      const re = new RegExp("(^|[^\\p{L}])" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}])", "iu");
      if (!re.test(v.text)) problems.push(v.ref + ": \"" + term + "\"");
      assert(meaning && meaning.length > 2, v.ref + " word '" + term + "' has no meaning");
    }
  }
  assert(problems.length === 0, "terms not found in verse text: " + problems.join(", "));
  await context.close();
});

test("lesson alignment: fill-in-the-blank quizzes match the verse", async () => {
  // Quizzes written as "... ___." quote the verse; the correct option must fill the blank.
  const { page, context } = await openApp();
  const d = await data(page);
  for (const v of d.verses) {
    const q = d.lessons[v.id].quiz;
    if (!q.q.includes("___")) continue;
    const answer = q.options[q.answer].toLowerCase();
    assert(v.text.toLowerCase().includes(answer), v.ref + " blank answer '" + answer + "' not in verse");
    for (let i = 0; i < 3; i++) {
      if (i === q.answer) continue;
      const filled = q.q.replace(/"/g, "").replace("___", q.options[i]).replace(/^.*?said,?\s*/i, "").replace(/[.?]$/, "").toLowerCase();
      assert(!v.text.toLowerCase().includes(filled), v.ref + " wrong option also fits the verse: " + q.options[i]);
    }
  }
  await context.close();
});

test("content: verse text matches the King James Version word for word", async () => {
  const file = process.env.KJV_JSON;
  if (!file || !fs.existsSync(file)) return "skipped (set KJV_JSON to enable)";
  const bible = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  const BOOKS = ["Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Joshua","Judges","Ruth","1 Samuel","2 Samuel","1 Kings","2 Kings","1 Chronicles","2 Chronicles","Ezra","Nehemiah","Esther","Job","Psalm","Proverbs","Ecclesiastes","Song of Solomon","Isaiah","Jeremiah","Lamentations","Ezekiel","Daniel","Hosea","Joel","Amos","Obadiah","Jonah","Micah","Nahum","Habakkuk","Zephaniah","Haggai","Zechariah","Malachi","Matthew","Mark","Luke","John","Acts","Romans","1 Corinthians","2 Corinthians","Galatians","Ephesians","Philippians","Colossians","1 Thessalonians","2 Thessalonians","1 Timothy","2 Timothy","Titus","Philemon","Hebrews","James","1 Peter","2 Peter","1 John","2 John","3 John","Jude","Revelation"];
  // Compare words only: sources differ on italics markers, and some on minor punctuation.
  const norm = (s) => s.replace(/\{[^}]*\}/g, (m) => m.slice(1, -1)).replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const { page, context } = await openApp();
  const problems = [];
  for (const v of (await data(page)).verses) {
    const m = v.ref.match(/^(.*) (\d+):(\d+)(?:-(\d+))?$/);
    const book = bible[BOOKS.indexOf(m[1])];
    assert(book, "unknown book " + m[1]);
    const chapter = book.chapters[+m[2] - 1];
    const from = +m[3], to = +(m[4] || m[3]);
    const kjv = chapter.slice(from - 1, to).join(" ");
    if (norm(kjv) !== norm(v.text)) problems.push(v.ref + "\n    app: " + v.text + "\n    KJV: " + kjv);
  }
  await context.close();
  assert(problems.length === 0, "verse text differs from KJV:\n  " + problems.join("\n  "));
});

// =====================================================================
// 2. HOME SCREEN
// =====================================================================
test("home: loads with 52 verse tiles, zero stars and no errors", async () => {
  const { page, context } = await openApp();
  eq(await page.locator(".verse-tile").count(), 52, "tile count");
  eq((await page.textContent("#totalStars")).trim(), "⭐ 0");
  eq((await page.textContent("#progressLabel")).trim(), "🏆 0 of 52 verses memorized");
  eq(await page.getAttribute("#practice", "class"), "hidden", "practice hidden on load");
  eq(page.appErrors().length, 0, "errors: " + page.appErrors().join("; "));
  await context.close();
});

test("home: Verse of the Week is a real verse and opens its lesson", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  const ref = (await page.textContent(".week-ref")).trim();
  const v = d.verses.find((x) => ref.endsWith(x.ref));
  assert(v, "week verse not in list: " + ref);
  eq((await page.textContent(".week-big")).trim(), d.lessons[v.id].big, "week card main idea");
  await page.click("text=Start this week's lesson");
  eq((await page.textContent("#practiceRef")).trim(), v.ref);
  eq(await page.getAttribute("[data-mode=lesson]", "aria-selected"), "true");
  await context.close();
});

function atDate(y, m, d) {
  const T = new Date(y, m, d, 12).getTime();
  return `(() => { const T = ${T}; const R = Date; globalThis.Date = class extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }; })()`;
}
async function weekVerseOn(y, m, d) {
  const { page, context } = await openApp({ init: atDate(y, m, d) });
  const ref = (await page.textContent(".week-ref")).trim();
  await context.close();
  return ref;
}

test("home: Verse of the Week changes on Mondays and doesn't repeat at New Year", async () => {
  // 28 Sep 2026 is a Monday.
  eq(await weekVerseOn(2026, 8, 28), await weekVerseOn(2026, 9, 4), "Monday and Sunday of one week match");
  assert(await weekVerseOn(2026, 9, 4) !== await weekVerseOn(2026, 9, 5), "changes on Monday");
  // Thu 31 Dec 2026 and Fri 1 Jan 2027 are in the same week, so they must match.
  eq(await weekVerseOn(2026, 11, 31), await weekVerseOn(2027, 0, 1), "no reset at New Year");
});

test("home: Verse of the Week changes weekly and cycles through all 52", async () => {
  const seen = new Set();
  for (let w = 0; w < 52; w++) {
    const t = new Date(2026, 0, 1).getTime() + w * 7 * 86400000 + 3600000;
    const { page, context } = await openApp({ init: `(() => { const T = ${t}; const R = Date; globalThis.Date = class extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }; })()` });
    seen.add((await page.textContent(".week-ref")).trim());
    await context.close();
  }
  eq(seen.size, 52, "distinct weekly verses in a year");
});

test("home: topic filters show only that topic, and 'All' shows everything", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  for (const t of d.topics) {
    await page.locator(".filter", { hasText: t.name }).click();
    const expected = d.verses.filter((v) => v.topic === t.id).map((v) => v.ref);
    const shown = await page.$$eval(".verse-tile .ref", (els) => els.map((e) => e.textContent));
    eq(JSON.stringify(shown), JSON.stringify(expected), "filter " + t.name);
    eq(await page.getAttribute(".filter[aria-pressed=true]", "aria-pressed"), "true");
    assert((await page.textContent(".filter[aria-pressed=true]")).includes(t.name), "pressed state");
  }
  await page.locator(".filter", { hasText: "All" }).click();
  eq(await page.locator(".verse-tile").count(), 52);
  eq(await page.locator(".topic-title").count(), d.topics.length, "one heading per topic");
  await context.close();
});

// =====================================================================
// 3. LESSON SCREEN
// =====================================================================
test("lesson: every verse opens on a lesson that shows all its parts", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  for (const v of d.verses) {
    const L = d.lessons[v.id];
    await openVerse(page, v.ref);
    eq(await page.getAttribute("[data-mode=lesson]", "aria-selected"), "true", v.ref + " starts on lesson");
    eq((await page.textContent("#practiceRef")).trim(), v.ref);
    eq((await page.textContent(".lesson-big")).trim(), L.big, v.ref + " main idea");
    assert((await page.textContent(".lesson-verse")).startsWith(v.text), v.ref + " verse shown in lesson");
    const heads = await page.$$eval(".step h3", (h) => h.map((x) => x.textContent));
    eq(JSON.stringify(heads), JSON.stringify(["💡 What does it mean?", "📝 Words to know", "💬 Think and talk", "❓ Check what you learned", "🙌 Live it this week", "🙏 Let's pray"]), v.ref + " sections");
    const stage = await page.textContent("#stage");
    for (const part of [L.meaning, L.talk, L.doIt, L.prayer, L.quiz.q]) assert(stage.includes(part), v.ref + " missing lesson text: " + part.slice(0, 30));
    eq(await page.locator(".words-list li").count(), L.words.length, v.ref + " words count");
    await page.click("#backBtn");
  }
  await context.close();
});

test("lesson: quiz marks wrong answers red, the right one green, then locks", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  for (const v of d.verses) {
    const q = d.lessons[v.id].quiz;
    await openVerse(page, v.ref);
    const opts = page.locator(".quiz-opt");
    for (let i = 0; i < 3; i++) {
      if (i === q.answer) continue;
      await opts.nth(i).click();
      assert((await opts.nth(i).getAttribute("class")).includes("nope"), v.ref + " wrong not red");
      assert(await opts.nth(i).isDisabled(), v.ref + " wrong not disabled");
      assert((await page.textContent(".quiz-msg")).includes("Not quite"), v.ref + " wrong message");
      break; // one wrong try, then answer correctly
    }
    await opts.nth(q.answer).click();
    assert((await opts.nth(q.answer).getAttribute("class")).includes("right"), v.ref + " right not green");
    assert((await page.textContent(".quiz-msg")).includes("That's right"), v.ref + " right message");
    for (let i = 0; i < 3; i++) assert(await opts.nth(i).isDisabled(), v.ref + " options locked after correct");
    eq(await page.locator(".quiz-opt.right").count(), 1);
    await page.click("#backBtn");
  }
  await context.close();
});

test("lesson: 'Start memorizing' goes to Read, and all tabs switch correctly", async () => {
  const { page, context } = await openApp();
  await openVerse(page, "John 3:16");
  await page.click("text=Start memorizing");
  eq(await page.getAttribute("[data-mode=read]", "aria-selected"), "true");
  for (const m of ["hide", "letters", "build", "lesson", "read"]) {
    await page.click(`[data-mode=${m}]`);
    eq(await page.locator(".tab[aria-selected=true]").count(), 1, "one selected tab");
    eq(await page.getAttribute(`[data-mode=${m}]`, "aria-selected"), "true", m);
  }
  await context.close();
});

// =====================================================================
// 4. GAMES
// =====================================================================
test("read: shows the exact verse; Next goes to Hide Words", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  for (const v of d.verses) {
    await openVerse(page, v.ref);
    await page.click("[data-mode=read]");
    eq((await page.textContent(".verse-text")).trim(), v.text, v.ref);
    await page.click("#backBtn");
  }
  await openVerse(page, "Psalm 23:1");
  await page.click("[data-mode=read]");
  await page.click("text=Next game");
  eq(await page.getAttribute("[data-mode=hide]", "aria-selected"), "true");
  await context.close();
});

test("hide words: starts at a quarter, 'Hide more', slider limits, peeking", async () => {
  const { page, context } = await openApp();
  const v = (await data(page)).verses.find((x) => x.ref === "John 3:16");
  const n = words(v.text).length;
  await openVerse(page, v.ref);
  await page.click("[data-mode=hide]");
  eq(await page.locator(".blank").count(), Math.ceil(n / 4), "initial blanks");
  eq(await page.locator(".blank").count() + await page.locator(".verse-text .word").count(), n, "every word shown or blanked");
  let prev = await page.locator(".blank").count();
  while (!(await page.locator("text=Hide more").isDisabled().catch(() => true))) {
    await page.click("text=Hide more");
    const now = await page.locator(".blank").count();
    assert(now > prev && now <= n, "hide more should increase, got " + prev + " -> " + now);
    prev = now;
    if (now === n) break;
  }
  eq(prev, n, "all words hidden eventually");
  assert((await page.textContent(".controls .btn")).includes("All hidden"), "all hidden label");
  assert(await page.locator(".controls .btn").isDisabled(), "button disabled when all hidden");
  await page.fill("#hideRange", "0");
  eq(await page.locator(".blank").count(), 0, "slider 0 shows all");
  assert(!(await page.locator(".controls .btn").isDisabled()), "button re-enabled");
  await page.fill("#hideRange", String(n));
  eq(await page.locator(".blank").count(), n, "slider max hides all");
  eq((await page.textContent(".meter label")).trim(), `Hidden words: ${n} of ${n}`);
  // Hidden words carry no visible text (so high-contrast modes can't reveal them)...
  eq((await page.$$eval(".verse-text .blank:not(.peeked)", (b) => b.map((x) => x.textContent).join(""))), "", "hidden words have no text");
  // ...and keep their word order: the blanks' words rebuild the verse.
  eq((await page.$$eval(".verse-text .blank", (b) => b.map((x) => x.dataset.word))).join(" "), v.text, "blanks in verse order");
  const first = page.locator(".blank").first();
  await first.click();
  assert((await first.getAttribute("class")).includes("peeked"), "peek on click");
  eq(await first.textContent(), words(v.text)[await page.$$eval(".verse-text > span", (els) => els.findIndex((e) => e.classList.contains("blank")))], "peek shows the word");
  await first.click();
  eq(await first.textContent(), "", "unpeek hides the word again");
  assert(!(await first.getAttribute("class")).includes("peeked"), "unpeek on second click");
  await first.focus();
  await page.keyboard.press("Enter");
  assert((await first.getAttribute("class")).includes("peeked"), "peek with Enter key");
  await context.close();
});

test("first letters: one letter per word, correct letters, tap/Enter to reveal", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  for (const v of d.verses) {
    await openVerse(page, v.ref);
    await page.click("[data-mode=letters]");
    const ws = words(v.text);
    const shown = await page.$$eval(".letters .fl", (e) => e.map((x) => x.textContent));
    eq(shown.length, ws.length, v.ref + " letter count");
    ws.forEach((w, i) => {
      const first = w.match(/[A-Za-z0-9]/)[0];
      assert(shown[i].startsWith(first), v.ref + ` word ${i} "${w}" shows "${shown[i]}"`);
    });
    await page.click("#backBtn");
  }
  await openVerse(page, "Psalm 23:1");
  await page.click("[data-mode=letters]");
  const fl = page.locator(".letters .fl").nth(1);
  eq(await fl.textContent(), "L");
  await fl.click();
  eq(await fl.textContent(), "LORD", "reveal on tap");
  await fl.click();
  eq(await fl.textContent(), "L", "hide on second tap");
  await fl.focus();
  await page.keyboard.press(" ");
  eq(await fl.textContent(), "LORD", "reveal with Space key");
  eq(await page.locator(".letters .fl").nth(4).textContent(), "s;", "punctuation kept after letter");
  await context.close();
});

test("build it: all 52 verses can be built correctly and award a star", async () => {
  const { page, context } = await openApp();
  const d = await data(page);
  for (const v of d.verses) {
    await openVerse(page, v.ref);
    await page.click("[data-mode=build]");
    const chips = await page.$$eval(".chip", (c) => c.map((x) => x.textContent));
    eq(JSON.stringify([...chips].sort()), JSON.stringify([...words(v.text)].sort()), v.ref + " chips are exactly the verse words");
    await buildCorrectly(page, v.text);
    eq((await page.$$eval(".built .placed", (p) => p.map((x) => x.textContent))).join(" "), v.text, v.ref + " built text");
    assert((await page.textContent(".celebrate")).includes("1 of 3"), v.ref + " star message");
    assert((await page.textContent(".celebrate")).includes("Perfect"), v.ref + " perfect message");
    await page.click("#backBtn");
  }
  eq((await page.textContent("#totalStars")).trim(), "⭐ 52", "one star each");
  await context.close();
});

test("build it: wrong taps don't advance, no 'Perfect' after a mistake", async () => {
  const { page, context } = await openApp();
  await openVerse(page, "1 John 4:19");
  await page.click("[data-mode=build]");
  await page.locator(".chip", { hasText: /^us\.$/ }).click();
  eq(await page.locator(".built .placed").count(), 0, "wrong tap places nothing");
  assert((await page.locator(".chip", { hasText: /^us\.$/ }).getAttribute("class")).includes("wrong"), "wrong chip shakes");
  await page.waitForTimeout(450);
  assert(!(await page.locator(".chip", { hasText: /^us\.$/ }).getAttribute("class")).includes("wrong"), "shake clears");
  await buildCorrectly(page, "We love him, because he first loved us.");
  assert(!(await page.textContent(".celebrate")).includes("Perfect"), "no perfect after mistake");
  assert(await page.locator(".pool").isHidden(), "pool hidden when done");
  assert(await page.locator("text=💡 Hint").isDisabled(), "hint disabled when done");
  await context.close();
});

test("build it: Hint highlights the next correct word; Start over resets", async () => {
  const { page, context } = await openApp();
  await openVerse(page, "Psalm 23:1");
  await page.click("[data-mode=build]");
  await page.click("text=💡 Hint");
  eq(await page.locator(".chip.glow").count(), 1);
  eq(await page.textContent(".chip.glow"), "The");
  await page.click(".chip.glow");
  eq(await page.locator(".chip.glow").count(), 0, "glow cleared after tap");
  await page.click("text=💡 Hint");
  eq(await page.textContent(".chip.glow"), "LORD");
  await page.click("text=Start over");
  eq(await page.locator(".built .placed").count(), 0, "reset built");
  eq(await page.locator(".chip.used").count(), 0, "reset chips");
  await context.close();
});

test("build it: using a hint gives no star and no 'Perfect'", async () => {
  const { page, context } = await openApp();
  await openVerse(page, "John 11:35");
  await page.click("[data-mode=build]");
  await page.click("text=💡 Hint");
  await page.click(".chip.glow");
  await buildCorrectly(page, "wept.");
  const msg = await page.textContent(".celebrate");
  assert(msg.includes("without hints"), "hint message: " + msg);
  assert(!msg.includes("Perfect"), "no perfect after hint");
  eq((await page.textContent("#totalStars")).trim(), "⭐ 0", "no star after hint");
  // Next round without hints earns the star.
  await page.click("text=Play again");
  await buildCorrectly(page, "Jesus wept.");
  assert((await page.textContent(".celebrate")).includes("Perfect"), "perfect without hint");
  eq((await page.textContent("#totalStars")).trim(), "⭐ 1");
  await context.close();
});

test("build it: repeated words (e.g. 'love one another' twice) work in any chip order", async () => {
  const { page, context } = await openApp();
  const text = (await data(page)).verses.find((v) => v.ref === "John 13:34").text;
  for (let round = 0; round < 3; round++) { // chips are shuffled each time
    await openVerse(page, "John 13:34");
    await page.click("[data-mode=build]");
    for (const w of words(text)) {
      const same = page.locator(".chip:not(.used)").filter({ hasText: new RegExp("^" + w.replace(/[.,;:]/g, "\\$&") + "$") });
      await same.last().click(); // pick the *last* duplicate to prove any copy is accepted
    }
    await page.waitForSelector(".celebrate");
    await page.click("#backBtn");
  }
  await context.close();
});

// =====================================================================
// 5. STARS, PROGRESS, SAVING
// =====================================================================
test("stars: 3 wins = trophy + memorized; 4th win never exceeds 3", async () => {
  const { page, context } = await openApp();
  const text = "Jesus wept.";
  for (let i = 1; i <= 4; i++) {
    await openVerse(page, "John 11:35");
    await page.click("[data-mode=build]");
    await buildCorrectly(page, text);
    const msg = await page.textContent(".celebrate");
    if (i < 3) assert(msg.includes(`${i} of 3`), "round " + i + ": " + msg);
    if (i === 3) assert(msg.includes("You memorized John 11:35"), "memorized message");
    if (i === 4) assert(msg.includes("Still a champion"), "champion message");
    eq(await page.locator("#verseStars .stars span:not(.off)").count(), Math.min(i, 3), "verse stars");
    await page.click("#backBtn");
  }
  eq((await page.textContent("#totalStars")).trim(), "⭐ 3");
  eq((await page.textContent("#progressLabel")).trim(), "🏆 1 of 52 verses memorized");
  const tile = page.locator(".verse-tile", { has: page.locator(".ref", { hasText: /^John 11:35$/ }) });
  assert((await tile.textContent()).includes("🏆"), "trophy on tile");
  assert((await page.textContent(".topic-title:has-text('Who Is Jesus')")).includes("1/8"), "topic count 1/8");
  await context.close();
});

test("saving: stars survive a page reload", async () => {
  const { page, context } = await openApp();
  await openVerse(page, "John 11:35");
  await page.click("[data-mode=build]");
  await buildCorrectly(page, "Jesus wept.");
  await page.reload();
  eq((await page.textContent("#totalStars")).trim(), "⭐ 1");
  await context.close();
});

test("saving: corrupted saved data doesn't break the app", async () => {
  const { page, context } = await openApp();
  await page.evaluate(() => localStorage.setItem("verseBuddies.v1", "{not json"));
  await page.reload();
  eq(await page.locator(".verse-tile").count(), 52);
  eq((await page.textContent("#totalStars")).trim(), "⭐ 0");
  eq(page.appErrors().length, 0, page.appErrors().join("; "));
  await context.close();
});

test("saving: wrongly shaped saved data is cleaned up, not trusted", async () => {
  const bad = [
    { custom: {} },
    { custom: [null, 5, "x", { id: "a", ref: "A 1:1" }, { id: "b", ref: " ", text: "x" }] },
    { stars: { "jn3-16": "2", "jn11-35": 99, "ps23-1": -4, "gen1-1": "abc" } },
    { stars: [1, 2, 3] },
    "just a string",
    null
  ];
  for (const data of bad) {
    const { page, context } = await openApp();
    await page.evaluate((d) => localStorage.setItem("verseBuddies.v1", JSON.stringify(d)), data);
    await page.reload();
    eq(await page.locator(".verse-tile").count(), 52, "only real verses for " + JSON.stringify(data));
    eq((await page.textContent("#progressLabel")).trim(), (data && data.stars && data.stars["jn11-35"]) ? "🏆 1 of 52 verses memorized" : "🏆 0 of 52 verses memorized", "progress for " + JSON.stringify(data));
    if (data && data.stars && data.stars["jn3-16"]) {
      // "2" becomes 2, 99 is capped at 3, negatives and junk are dropped: 2 + 3 = 5.
      eq((await page.textContent("#totalStars")).trim(), "⭐ 5", "star values cleaned");
    }
    // Adding a verse still works after a bad save.
    await page.click("#addBtn");
    await page.fill("#newRef", "Test 1:1");
    await page.fill("#newText", "Hello there.");
    await page.click("text=Save verse");
    eq(await page.locator(".verse-tile").count(), 53, "can add a verse after " + JSON.stringify(data));
    eq(page.appErrors().length, 0, page.appErrors().join("; "));
    await context.close();
  }
});

test("saving: app still fully works when storage is blocked (private mode)", async () => {
  const { page, context } = await openApp({
    init: "Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });"
  });
  eq(await page.locator(".verse-tile").count(), 52);
  await openVerse(page, "John 11:35");
  await page.click("[data-mode=build]");
  await buildCorrectly(page, "Jesus wept.");
  eq((await page.textContent("#totalStars")).trim(), "⭐ 1", "stars still count this session");
  eq(page.appErrors().length, 0, page.appErrors().join("; "));
  await context.close();
});

// =====================================================================
// 6. INPUTS: add my own verse
// =====================================================================
test("add verse: form opens, has limits, and Cancel clears it", async () => {
  const { page, context } = await openApp();
  assert(await page.locator("#addCard").isHidden(), "form hidden at start");
  await page.click("#addBtn");
  assert(await page.locator("#addCard").isVisible(), "form opens");
  assert(await page.evaluate(() => document.activeElement.id === "newRef"), "focus moves to first field");
  eq(await page.getAttribute("#newRef", "maxlength"), "60");
  eq(await page.getAttribute("#newText", "maxlength"), "600");
  await page.fill("#newRef", "Test 1:1");
  await page.click("#cancelAdd");
  assert(await page.locator("#addCard").isHidden(), "cancel hides");
  await page.click("#addBtn");
  eq(await page.inputValue("#newRef"), "", "cancel cleared the field");
  await context.close();
});

test("add verse: empty or whitespace-only input is rejected", async () => {
  const { page, context } = await openApp();
  await page.click("#addBtn");
  await page.click("text=Save verse"); // both empty: browser 'required' blocks it
  eq(await page.locator(".verse-tile").count(), 52, "empty rejected");
  await page.fill("#newRef", "   ");
  await page.fill("#newText", "   ");
  await page.click("text=Save verse");
  eq(await page.locator(".verse-tile").count(), 52, "whitespace rejected");
  await page.fill("#newRef", "Test 1:1");
  await page.fill("#newText", "");
  await page.click("text=Save verse");
  eq(await page.locator(".verse-tile").count(), 52, "missing text rejected");
  await context.close();
});

test("add verse: saves, tidies spaces, joins 'My Verses', counts toward progress, survives reload", async () => {
  const { page, context } = await openApp();
  await page.click("#addBtn");
  await page.fill("#newRef", "  Colossians 3:20  ");
  await page.fill("#newText", "Children,   obey your parents\n in all things: for this is well pleasing unto the Lord.");
  await page.click("text=Save verse");
  assert(await page.locator("#addCard").isHidden(), "form closes after save");
  eq(await page.locator(".verse-tile").count(), 53);
  eq((await page.textContent("#progressLabel")).trim(), "🏆 0 of 53 verses memorized");
  await page.locator(".filter", { hasText: "My Verses" }).click();
  eq(await page.locator(".verse-tile").count(), 1, "My Verses filter");
  eq(await page.textContent(".verse-tile .ref"), "Colossians 3:20", "ref trimmed");
  eq(await page.textContent(".verse-tile .peek"), "Children, obey your parents in all things: for this is well pleasing unto the Lord.", "spaces tidied");
  await page.reload();
  eq(await page.locator(".verse-tile").count(), 53, "custom verse saved");
  await context.close();
});

test("add verse: custom verse gets a general lesson and every game works", async () => {
  const { page, context } = await openApp();
  const text = "Be ye kind, be ye kind.";
  await page.click("#addBtn");
  await page.fill("#newRef", "My Verse 1:1");
  await page.fill("#newText", text);
  await page.click("text=Save verse");
  await openVerse(page, "My Verse 1:1");
  eq(await page.locator(".quiz-opt").count(), 0, "no quiz for custom");
  const heads = await page.$$eval(".step h3", (h) => h.map((x) => x.textContent));
  eq(JSON.stringify(heads), JSON.stringify(["💡 What does it mean?", "💬 Think and talk", "🙌 Live it this week", "🙏 Let's pray"]));
  assert((await page.textContent("#stage")).includes("My Verse 1:1"), "lesson mentions the ref");
  await page.click("[data-mode=read]");
  eq((await page.textContent(".verse-text")).trim(), text);
  await page.click("[data-mode=hide]");
  eq(await page.locator(".blank").count(), Math.ceil(words(text).length / 4));
  await page.click("[data-mode=letters]");
  eq(await page.locator(".letters .fl").count(), words(text).length);
  await page.click("[data-mode=build]");
  await buildCorrectly(page, text);
  await context.close();
});

test("add verse: non-English verses need the right order and show the right first letters", async () => {
  const { page, context } = await openApp();
  const text = "Бог есть любовь. Él es (amor), 하나님은 사랑이시라.";
  await page.click("#addBtn");
  await page.fill("#newRef", "Other 1:1");
  await page.fill("#newText", text);
  await page.click("text=Save verse");
  await openVerse(page, "Other 1:1");
  await page.click("[data-mode=letters]");
  eq(JSON.stringify(await page.$$eval(".letters .fl", (e) => e.map((x) => x.textContent))),
     JSON.stringify(["Б", "е", "л.", "É", "e", "(a),", "하", "사."]), "first letters");
  await page.click("[data-mode=build]");
  // A wrong word must be rejected (before the fix, every non-Latin word matched every slot).
  await page.locator(".chip", { hasText: /^любовь\.$/ }).click();
  eq(await page.locator(".built .placed").count(), 0, "wrong non-Latin word rejected");
  await buildCorrectly(page, text);
  eq((await page.$$eval(".built .placed", (p) => p.map((x) => x.textContent))).join(" "), text, "built in order");
  eq(page.appErrors().length, 0, page.appErrors().join("; "));
  await context.close();
});

test("add verse: HTML/script typed into the form is shown as plain text, never run", async () => {
  const { page, context } = await openApp();
  await page.click("#addBtn");
  const evil = '<img src=x onerror="window.__hacked=1">';
  await page.fill("#newRef", evil);
  await page.fill("#newText", '<script>window.__hacked=1</script> hello');
  await page.click("text=Save verse");
  await openVerse(page, evil);
  for (const m of ["lesson", "read", "hide", "letters", "build"]) await page.click(`[data-mode=${m}]`);
  await page.click("#backBtn");
  eq(await page.evaluate(() => window.__hacked), undefined, "script executed!");
  eq(await page.locator("#verseGrid img").count(), 0, "img tag injected");
  assert((await page.textContent("#verseGrid")).includes(evil), "shown as text");
  await context.close();
});

// =====================================================================
// 7. LISTEN (read aloud)
// =====================================================================
test("listen: reads the verse and reference aloud, slowly", async () => {
  const { page, context } = await openApp({
    init: `window.__spoken = [];
           Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { cancel() {}, speak(u) { window.__spoken.push(u); } } });
           window.SpeechSynthesisUtterance = function (t) { this.text = t; };`
  });
  await openVerse(page, "Psalm 23:1");
  await page.click("text=🔊 Listen");
  const spoken = await page.evaluate(() => window.__spoken.map((u) => ({ text: u.text, rate: u.rate })));
  eq(spoken.length, 1);
  eq(spoken[0].text, "The LORD is my shepherd; I shall not want. Psalm 23:1", "no doubled period");
  assert(spoken[0].rate < 1, "slower than normal for kids");
  await context.close();
});

test("listen: shows 'Not available' where the device can't speak", async () => {
  const { page, context } = await openApp({ init: "delete window.speechSynthesis; delete Window.prototype.speechSynthesis;" });
  eq(await page.evaluate(() => "speechSynthesis" in window), false, "speech removed for test");
  await openVerse(page, "Psalm 23:1");
  await page.click("text=🔊 Listen");
  assert((await page.textContent("#stage .btn.sun")).includes("Not available"), "listen button should say Not available");
  await context.close();
});

// =====================================================================
// 8. LAYOUT, THEMES, ACCESSIBILITY
// =====================================================================
test("layout: no sideways scrolling on small phones, tablets and desktop", async () => {
  for (const width of [320, 360, 390, 768, 1280]) {
    const { page, context } = await openApp({ viewport: { width, height: 800 } });
    const check = async (where) => {
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(sw <= width, `${where} at ${width}px scrolls sideways (${sw}px)`);
    };
    await check("home");
    await openVerse(page, "Isaiah 41:10"); // longest verse
    for (const m of ["lesson", "read", "hide", "letters", "build"]) {
      await page.click(`[data-mode=${m}]`);
      await check(m);
    }
    await context.close();
  }
});

test("theme: dark mode switches colors and keeps text readable", async () => {
  const bg = async (scheme) => {
    const { page, context } = await openApp({ colorScheme: scheme });
    const c = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
    await context.close();
    return c;
  };
  const light = await bg("light"), dark = await bg("dark");
  assert(light[0] !== dark[0], "background should change in dark mode");
  const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  assert(lum(dark[0]) < 80 && lum(dark[1]) > 180, "dark bg with light text: " + dark);
  assert(lum(light[0]) > 200 && lum(light[1]) < 80, "light bg with dark text: " + light);
});

test("accessibility: page has a title, lang, and every button is reachable", async () => {
  const { page, context } = await openApp();
  eq(await page.title(), "Verse Buddies");
  eq(await page.getAttribute("html", "lang"), "en");
  const unlabeled = await page.$$eval("button", (bs) => bs.filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label")).length);
  eq(unlabeled, 0, "buttons without a label");
  await page.keyboard.press("Tab");
  eq(await page.evaluate(() => document.activeElement.tagName), "BUTTON", "keyboard can reach buttons");
  await context.close();
});

test("navigation: Back returns home and shows updated stars", async () => {
  const { page, context } = await openApp();
  await openVerse(page, "John 11:35");
  await page.click("[data-mode=build]");
  await buildCorrectly(page, "Jesus wept.");
  await page.click("#backBtn");
  assert(await page.locator("#home").isVisible(), "home visible");
  assert(await page.locator("#practice").isHidden(), "practice hidden");
  const tile = page.locator(".verse-tile", { has: page.locator(".ref", { hasText: /^John 11:35$/ }) });
  eq(await tile.locator(".stars span:not(.off)").count(), 1, "tile shows 1 star");
  await context.close();
});

// ---------- run ----------
(async () => {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let failed = 0, skipped = 0;
  const started = Date.now();
  const only = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER, "i") : null;
  for (const t of tests) {
    if (only && !only.test(t.name)) continue;
    try {
      const note = await t.fn();
      if (typeof note === "string" && note.startsWith("skipped")) { skipped++; console.log("  ○ " + t.name + "  — " + note); }
      else console.log("  ✓ " + t.name);
    } catch (e) {
      failed++;
      console.log("  ✗ " + t.name + "\n      " + String(e.message).split("\n").join("\n      "));
    }
  }
  await browser.close();
  const passed = tests.filter((t) => !only || only.test(t.name)).length - failed - skipped;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  process.exit(failed ? 1 : 0);
})();

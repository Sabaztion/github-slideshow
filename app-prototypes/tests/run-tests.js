const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const APPS_DIR = path.resolve(__dirname, '..');

function fileUrl(name) {
  return 'file://' + path.join(APPS_DIR, name);
}

async function withPage(browser, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });
  try {
    await fn(page, errors);
  } finally {
    await context.close();
  }
  return errors;
}

async function testMomentum(browser) {
  return withPage(browser, async (page, errors) => {
    await page.goto(fileUrl('momentum.html'));
    await page.waitForSelector('#nowTitle');

    const initialTitle = await page.textContent('#nowTitle');
    assert.ok(initialTitle && initialTitle.trim().length > 0, 'now title should not be empty');

    await page.fill('#clock', '540');
    await page.dispatchEvent('#clock', 'input');
    const label = await page.textContent('#clockLabel');
    assert.strictEqual(label, '9:00 AM', 'clock label should reflect slider value, got ' + label);

    await page.fill('#fTitle', 'Playwright test task');
    await page.fill('#fStart', '09:05');
    await page.fill('#fEnd', '09:20');
    await page.click('#addForm button[type=submit]');
    const rowText = await page.textContent('#weekList');
    assert.ok(rowText.includes('Playwright test task'), 'new task should appear in week list');

    const testRow = page.locator('#weekList .row', { hasText: 'Playwright test task' });
    await testRow.locator('button[data-act="del"]').click();
    const rowTextAfter = await page.textContent('#weekList');
    assert.ok(!rowTextAfter.includes('Playwright test task'), 'removed task should disappear');

    await page.evaluate(() => { window.__xssFired = false; });
    await page.fill('#fTitle', '<img src=x onerror="window.__xssFired=true">');
    await page.fill('#fStart', '09:01');
    await page.fill('#fEnd', '09:02');
    await page.click('#addForm button[type=submit]');
    await page.waitForTimeout(100);
    const xssFired = await page.evaluate(() => window.__xssFired);
    assert.strictEqual(xssFired, false, 'injected markup in task title must not execute');
    const injectedImgCount = await page.locator('#weekList img, #rail img').count();
    assert.strictEqual(injectedImgCount, 0, 'injected <img> tag must not be rendered as an element');
    const literalText = await page.textContent('#weekList');
    assert.ok(literalText.includes('<img src=x'), 'injected markup should render as literal visible text');

    return errors;
  });
}

async function testKeystone(browser) {
  return withPage(browser, async (page, errors) => {
    await page.goto(fileUrl('keystone.html'));
    await page.waitForSelector('#assets .asset');

    const countBefore = await page.locator('#assets .asset').count();
    assert.ok(countBefore >= 5, 'should have seeded assets, got ' + countBefore);

    await page.click('.filter:text("Appliance")');
    const namesAfterFilter = await page.locator('#assets .asset .name').allTextContents();
    assert.ok(namesAfterFilter.length > 0, 'appliance filter should show at least one asset');

    await page.click('.filter:text("All")');

    const firstAsset = page.locator('#assets .asset').first();
    const beforeService = await firstAsset.locator('.row').nth(1).locator('b').textContent();
    await firstAsset.locator('button[data-act="service"]').click();
    const afterAsset = page.locator('#assets .asset').first();
    const afterService = await afterAsset.locator('.row').nth(1).locator('b').textContent();
    assert.notStrictEqual(beforeService, afterService, 'logging service should change next-service date');

    const countBeforeRemove = await page.locator('#assets .asset').count();
    await page.locator('#assets .asset').first().locator('button[data-act="remove"]').click();
    const countAfterRemove = await page.locator('#assets .asset').count();
    assert.strictEqual(countAfterRemove, countBeforeRemove - 1, 'removing an asset should decrease count');

    await page.fill('#fName', 'Test water softener');
    await page.fill('#fInstalled', '2024-01-01');
    await page.click('#addForm button[type=submit]');
    const allNames = await page.locator('#assets .asset .name').allTextContents();
    assert.ok(allNames.some(n => n.includes('Test water softener')), 'new asset should appear');

    await page.evaluate(() => { window.__xssFired = false; });
    await page.fill('#fName', '<img src=x onerror="window.__xssFired=true">');
    await page.fill('#fInstalled', '2024-01-01');
    await page.click('#addForm button[type=submit]');
    await page.waitForTimeout(100);
    const xssFired = await page.evaluate(() => window.__xssFired);
    assert.strictEqual(xssFired, false, 'injected markup in asset name must not execute');
    const injectedImgCount = await page.locator('#assets img, #taskList img').count();
    assert.strictEqual(injectedImgCount, 0, 'injected <img> tag must not be rendered as an element');

    return errors;
  });
}

async function testTideline(browser) {
  return withPage(browser, async (page, errors) => {
    await page.goto(fileUrl('tideline.html'));
    await page.waitForSelector('#safeAmt');

    const safeText = await page.textContent('#safeAmt');
    assert.ok(/^\$[\d,]+\/day$/.test(safeText.trim()), 'safe-to-spend should be formatted as $N/day, got ' + safeText);

    const bufferBefore = await page.textContent('#bufferAmt');
    const eventCountBefore = await page.locator('#events .row').count();
    await page.locator('#events .row button.minibtn').first().click();
    const bufferAfter = await page.textContent('#bufferAmt');
    const eventCountAfter = await page.locator('#events .row').count();
    assert.notStrictEqual(bufferBefore, bufferAfter, 'buffer should change after settling a bill/payment');
    assert.strictEqual(eventCountAfter, eventCountBefore - 1, 'settled event should be removed from list');

    await page.fill('#targetSlider', '6');
    await page.dispatchEvent('#targetSlider', 'input');
    const targetLabel = await page.textContent('#targetWeeksLabel');
    assert.strictEqual(targetLabel.trim(), '6', 'target weeks label should update, got ' + targetLabel);

    await page.evaluate(() => { window.__xssFired = false; });
    await page.fill('#fName', '<img src=x onerror="window.__xssFired=true">');
    await page.fill('#fAmt', '50');
    await page.fill('#fDate', '2099-01-01');
    await page.selectOption('#fType', 'expense');
    await page.click('#addForm button[type=submit]');
    await page.waitForTimeout(100);
    const xssFired = await page.evaluate(() => window.__xssFired);
    assert.strictEqual(xssFired, false, 'injected markup in a logged item name must not execute');
    const injectedImgCount = await page.locator('#events img').count();
    assert.strictEqual(injectedImgCount, 0, 'injected <img> tag must not be rendered as an element');

    return errors;
  });
}

async function testPolyglot(browser) {
  return withPage(browser, async (page, errors) => {
    await page.goto(fileUrl('polyglot.html'));
    await page.waitForSelector('.phrase');

    await page.locator('.phrase').nth(1).click();
    const relayText = await page.textContent('#relay');
    assert.ok(relayText.includes('Merci beaucoup') || relayText.includes('Muchas gracias'), 'relay cards should show translated phrase, got: ' + relayText);

    await page.fill('#customInput', 'Thank you very much');
    await page.click('#customGo');
    const sourceAfterCustom = await page.textContent('#sourceText');
    assert.strictEqual(sourceAfterCustom.trim(), 'Thank you very much', 'custom lookup should match known phrase');

    await page.fill('#customInput', 'gibberish not in dictionary');
    await page.click('#customGo');
    const fallbackText = await page.textContent('#sourceText');
    assert.ok(fallbackText.includes('No preset translation'), 'unknown phrase should show honest fallback, got: ' + fallbackText);

    await page.locator('.phrase').nth(0).click();
    await page.click('#saveStar');
    const savedVisible = await page.isVisible('#savedSection');
    assert.ok(savedVisible, 'saved section should appear after starring a phrase');

    const baseBefore = await page.inputValue('#baseLang');
    await page.locator('.relay .card').first().click();
    const baseAfter = await page.inputValue('#baseLang');
    assert.notStrictEqual(baseBefore, baseAfter, 'clicking a translation card should swap the base language');

    return errors;
  });
}

async function testMiqat(browser) {
  return withPage(browser, async (page, errors) => {
    await page.goto(fileUrl('salah.html'));
    await page.waitForSelector('#nextName');

    await page.fill('#clock', '0');
    await page.dispatchEvent('#clock', 'input');
    const nextName = await page.textContent('#nextName');
    assert.strictEqual(nextName.trim(), 'Fajr', 'at midnight, next prayer should be Fajr, got ' + nextName);

    const fajrCheck = page.locator('.prayer', { hasText: 'Fajr' }).locator('.check');
    await fajrCheck.click();
    await assert.ok(await page.locator('.prayer', { hasText: 'Fajr' }).locator('.check').evaluate(el => el.classList.contains('done')), 'Fajr should be marked done');

    const jamaahBtn = page.locator('.prayer', { hasText: 'Fajr' }).locator('.jamaah');
    await jamaahBtn.click();
    assert.ok(await jamaahBtn.evaluate(el => el.classList.contains('on')), 'jamaah toggle should turn on');

    await page.selectOption('#methodSel', 'Umm al-Qura (Makkah)');
    const gridCount = await page.locator('#monthGrid .day').count();
    assert.strictEqual(gridCount, 30, 'month grid should have 30 day cells, got ' + gridCount);

    return errors;
  });
}

async function testCommons(browser) {
  return withPage(browser, async (page, errors) => {
    await page.goto(fileUrl('commons.html'));
    await page.waitForSelector('.post');

    const countBefore = await page.locator('.post').count();
    assert.ok(countBefore >= 5, 'should have seeded posts, got ' + countBefore);

    await page.click('.tab:text("Offerings")');
    const badges = await page.locator('.post .badge').allTextContents();
    assert.ok(badges.every(b => b === 'Offering'), 'filtered tab should show only offerings, got ' + badges.join(','));
    await page.click('.tab:text("All")');

    await page.fill('#fTitle', 'Playwright test post');
    await page.fill('#fDesc', 'Testing the form');
    await page.click('#addForm button[type=submit]');
    const titles = await page.locator('.post .title').allTextContents();
    assert.ok(titles.includes('Playwright test post'), 'new post should appear');

    const newPost = page.locator('.post', { hasText: 'Playwright test post' });
    await newPost.locator('.replyform input').fill('a test reply');
    await newPost.locator('.replyform button').click();
    const repliesText = await newPost.locator('.replies').textContent();
    assert.ok(repliesText.includes('a test reply'), 'reply should be added to the post');

    await newPost.locator('button[data-act="delete"]').click();
    const titlesAfter = await page.locator('.post .title').allTextContents();
    assert.ok(!titlesAfter.includes('Playwright test post'), 'own post should be removable');

    await page.selectOption('#sortSel', 'new');

    await page.evaluate(() => { window.__xssFired = false; });
    await page.fill('#fTitle', '<img src=x onerror="window.__xssFired=true">');
    await page.fill('#fDesc', '<img src=x onerror="window.__xssFired=true">');
    await page.click('#addForm button[type=submit]');
    await page.waitForTimeout(100);
    const xssFiredPost = await page.evaluate(() => window.__xssFired);
    assert.strictEqual(xssFiredPost, false, 'injected markup in post title/desc must not execute');
    assert.strictEqual(await page.locator('#posts img').count(), 0, 'injected <img> tag in a post must not render as an element');

    const xssPost = page.locator('.post', { hasText: '<img src=x' });
    await xssPost.locator('.replyform input').fill('<img src=x onerror="window.__xssFired=true">');
    await xssPost.locator('.replyform button').click();
    await page.waitForTimeout(100);
    const xssFiredReply = await page.evaluate(() => window.__xssFired);
    assert.strictEqual(xssFiredReply, false, 'injected markup in a reply must not execute');
    assert.strictEqual(await page.locator('#posts img').count(), 0, 'injected <img> tag in a reply must not render as an element');
    await xssPost.locator('button[data-act="delete"]').click();

    return errors;
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const suite = [
    ['momentum.html', testMomentum],
    ['keystone.html', testKeystone],
    ['tideline.html', testTideline],
    ['polyglot.html', testPolyglot],
    ['salah.html', testMiqat],
    ['commons.html', testCommons],
  ];

  let allPassed = true;
  for (const [name, fn] of suite) {
    process.stdout.write('Testing ' + name + ' ... ');
    try {
      const errors = await fn(browser);
      const realErrors = errors.filter(e => !e.includes('Failed to load resource') && !e.includes('net::ERR'));
      if (realErrors.length > 0) {
        allPassed = false;
        console.log('FAIL (console/page errors)');
        realErrors.forEach(e => console.log('    ' + e));
      } else {
        console.log('PASS');
      }
    } catch (err) {
      allPassed = false;
      console.log('FAIL');
      console.log('    ' + err.message);
    }
  }

  await browser.close();
  process.exit(allPassed ? 0 : 1);
}

main();

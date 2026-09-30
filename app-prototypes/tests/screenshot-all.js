const { chromium } = require('playwright');
const path = require('path');

const APPS_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(APPS_DIR, 'screenshots');

function fileUrl(name) {
  return 'file://' + path.join(APPS_DIR, name);
}

async function main() {
  const fs = require('fs');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const apps = ['momentum.html', 'keystone.html', 'tideline.html', 'polyglot.html', 'salah.html', 'commons.html'];

  for (const app of apps) {
    const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fileUrl(app), { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Give each prototype a small realistic interaction before the shot, so the
    // screenshot shows the app doing something, not just its resting state.
    if (app === 'polyglot.html') await page.locator('.phrase').first().click().catch(() => {});
    if (app === 'salah.html') await page.fill('#clock', '300').then(() => page.dispatchEvent('#clock', 'input')).catch(() => {});
    if (app === 'momentum.html') await page.fill('#clock', '600').then(() => page.dispatchEvent('#clock', 'input')).catch(() => {});

    const outPath = path.join(OUT_DIR, app.replace('.html', '.png'));
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(app + ' -> ' + outPath + (errors.length ? ' (errors: ' + errors.join('; ') + ')' : ''));
    await context.close();
  }

  await browser.close();
}

main();

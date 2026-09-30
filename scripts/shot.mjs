#!/usr/bin/env node
// Screenshot a page with headless Chromium (system /usr/bin/chromium).
//   node scripts/shot.mjs <url> <out.png> [--w 1600] [--h 1000] [--wait 1500]
//     [--click "<css>"]... [--key "Control+k"]... [--eval "<js>"]
// Actions run in the order given, each followed by a short settle. Prints console errors.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const [url, out] = args;
if (!url || !out) {
  console.error('usage: shot.mjs <url> <out.png> [--w N] [--h N] [--wait ms] [--click css] [--key k] [--eval js]');
  process.exit(2);
}
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
const page = await browser.newPage({ viewport: { width: Number(opt('--w', 1600)), height: Number(opt('--h', 1000)) } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(Number(opt('--wait', 1500)));
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--click') await page.click(args[++i]);
  else if (args[i] === '--key') await page.keyboard.press(args[++i]);
  else if (args[i] === '--eval') console.log(await page.evaluate(args[++i]));
  else continue;
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out });
if (errors.length) console.log('console errors:\n' + errors.join('\n'));
await browser.close();
console.log(out);

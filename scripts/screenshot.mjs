// Screenshot generator — headless Edge via playwright-core (dev-only tool).
// Usage: node scripts/screenshot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:4315';
const OUT = path.resolve(new URL('../docs/screenshots', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
fs.mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

// locate Edge
const edgePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const edge = edgePaths.find((p) => fs.existsSync(p));
if (!edge) { console.error('Edge not found'); process.exit(1); }

const browser = await chromium.launch({ executablePath: edge, headless: true });

// anonymous context — for landing, docs and the real login screen
const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });

// logged-in context
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const login = await context.request.post(`${BASE}/api/admin/login`, {
  data: { username: env.ADMIN_USERNAME || 'admin', password: env.ADMIN_PASSWORD },
});
if (!login.ok()) { console.error('login failed', login.status()); process.exit(1); }
const setCookie = login.headers()['set-cookie'];
const cookiePair = setCookie.split(';')[0];
const [name, value] = cookiePair.split('=');
await context.addCookies([{ name, value, url: BASE }]);

const shots = [
  ['landing.png', anon, `${BASE}/`, 4000, false],
  ['login.png', anon, `${BASE}/admin`, 2000, false],
  ['chat.png', context, `${BASE}/admin`, 3000, false, 'chat', 'open-first'],
  ['dashboard.png', context, `${BASE}/admin`, 4500, false, 'dashboard'],
  ['keys.png', context, `${BASE}/admin`, 2000, false, 'keys'],
  ['tokens.png', context, `${BASE}/admin`, 2500, false, 'tokens'],
  ['logs.png', context, `${BASE}/admin`, 2500, false, 'logs'],
  ['audit.png', context, `${BASE}/admin`, 2000, false, 'audit'],
  ['docs.png', anon, `${BASE}/docs`, 2500, false],
];

for (const [file, ctx, url, wait, fullPage, clickView, extra] of shots) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  // the film-grain overlay is pure noise — it makes PNGs 10x larger
  await page.addStyleTag({ content: '.grain{display:none!important}' });
  if (clickView) {
    await page.waitForSelector('.side-item', { timeout: 10000 }).catch(() => {});
    await page.evaluate((v) => {
      const btn = document.querySelector(`.side-item[data-view="${v}"]`);
      if (btn) btn.click();
    }, clickView);
  }
  if (extra === 'open-first') {
    await page.waitForSelector('.chat-item', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('.chat-item')?.click());
  }
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(OUT, file), fullPage });
  console.log('✓', file);
  await page.close();
}

await browser.close();
console.log('screenshots done →', OUT);

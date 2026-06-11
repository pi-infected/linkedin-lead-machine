/** One-shot : capture la vraie requête commentaires utilisée par le front LinkedIn. */
import { chromium } from 'patchright';
import { resolve } from 'node:path';

const PROFILE_DIR = resolve('state/browser-profile');
const ACT = process.argv[2] || 'urn:li:activity:7466099814343168001';

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: 'chrome', viewport: { width: 1440, height: 1200 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());

const hits: string[] = [];
page.on('request', (r) => {
  const u = r.url();
  if (/voyager\/api/.test(u) && /[Cc]omment/.test(u)) hits.push(u);
});

await page.goto(`https://www.linkedin.com/feed/update/${ACT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
// scroll pour déclencher le chargement des commentaires
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(1500);
}
// tenter de cliquer un bouton commentaires si présent
try {
  const btn = page.locator('button:has-text("comment"), button[aria-label*="omment"]').first();
  if (await btn.count()) {
    await btn.click({ timeout: 3000 });
    await page.waitForTimeout(4000);
  }
} catch {}

const uniq = [...new Set(hits)];
console.log('=== requêtes comments capturées ===');
for (const u of uniq) {
  const qid = u.match(/queryId=([^&]+)/)?.[1];
  const vars = u.match(/variables=([^&]+)/)?.[1];
  console.log('\nURL:', u.slice(0, 60), '...');
  console.log('queryId:', qid);
  console.log('variables(decoded):', vars ? decodeURIComponent(vars) : '(none)');
}
if (!uniq.length) console.log('(aucune requête comments capturée — il faudra cliquer manuellement)');
await ctx.close();
process.exit(0);

/** Capture la vraie requête de recherche de personnes filtrée "United States". */
import { chromium } from 'patchright';
import { resolve } from 'node:path';

const PROFILE_DIR = resolve('state/browser-profile');
const KW = process.argv[2] || 'llm inference cost';
const US_GEO = '103644278'; // urn:li:geo United States

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: 'chrome', viewport: { width: 1440, height: 1200 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());

const hits: string[] = [];
page.on('request', (r) => {
  const u = r.url();
  if (/voyager\/api\/graphql/.test(u)) hits.push(u);
});

const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(KW)}&geoUrn=%5B%22${US_GEO}%22%5D&origin=FACETED_SEARCH`;
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await page.mouse.wheel(0, 2000);
await page.waitForTimeout(4000);
await page.mouse.wheel(0, 2000);
await page.waitForTimeout(3000);

const uniq = [...new Set(hits)];
console.log('=== TOUTES les requêtes graphql capturées:', uniq.length, '===');
for (const u of uniq) {
  const qid = u.match(/queryId=([^&]+)/)?.[1] || '(no queryId)';
  const vars = u.match(/variables=([^&]+)/)?.[1];
  const dec = vars ? decodeURIComponent(vars) : '';
  // n'imprime en détail que ce qui ressemble à la recherche de personnes
  if (/Cluster|PEOPLE|geoUrn|Typeahead/i.test(dec) || /Cluster/i.test(qid)) {
    console.log('\n>>> queryId:', qid);
    console.log('    variables:', dec.slice(0, 400));
  } else {
    console.log('-', qid);
  }
}
if (!uniq.length) console.log('(rien capturé)');
await ctx.close();
process.exit(0);

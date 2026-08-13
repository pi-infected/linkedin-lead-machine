/**
 * Transport NAVIGATEUR (Playwright).
 *
 * Pourquoi : reproduire ce que faisait l'app Electron/extension Chrome — les
 * requêtes Voyager partent d'un VRAI navigateur connecté (empreinte TLS de
 * Chrome, jar de cookies complet et rafraîchi, session réchauffée). On ne
 * scrape PAS le DOM : on exécute les mêmes `fetch()` Voyager *à l'intérieur*
 * d'une page linkedin.com via page.evaluate, et on récupère le JSON normalisé.
 *
 * La session vit dans un profil persistant (state/browser-profile) : on se
 * connecte une seule fois (`lk login`, fenêtre visible, gère 2FA/captcha), puis
 * toutes les commandes réutilisent ce profil.
 */
// patchright = fork stealth de Playwright, API identique. Tourne en HEADFUL
// (headless:false) sous xvfb pour un rendu sans écran physique — c'est la combo
// non-détectée. Ne PAS ajouter d'args type --disable-blink-features : patchright
// gère le stealth lui-même et ces flags le cassent.
import { chromium, BrowserContext, Page } from 'patchright';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readlinkSync, rmSync } from 'node:fs';
import { STATE_DIR, getCookieConfig } from '../config.js';
import { loadCookiesFromFile, PwCookie } from '../cookies-import.js';

const PROFILE_DIR = resolve(STATE_DIR, 'browser-profile');

let _ctx: BrowserContext | null = null;
let _page: Page | null = null;

/**
 * Chemins d'installation standard de Chrome/Edge par OS (fallback si le canal
 * `chrome` de Playwright échoue à le localiser). Surcharge manuelle : LK_CHROME_PATH.
 */
function findChrome(): string | undefined {
  const override = process.env.LK_CHROME_PATH;
  if (override && existsSync(override)) return override;
  const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const PFx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const LAD = process.env['LOCALAPPDATA'] || '';
  const cands =
    process.platform === 'win32'
      ? [
          `${PF}\\Google\\Chrome\\Application\\chrome.exe`,
          `${PFx86}\\Google\\Chrome\\Application\\chrome.exe`,
          `${LAD}\\Google\\Chrome\\Application\\chrome.exe`,
          `${PF}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/opt/google/chrome/chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
          ];
  return cands.find((c) => c && existsSync(c));
}

/**
 * Retire un SingletonLock RÉSIDUEL laissé par un process navigateur mort (crash/kill
 * de session). Le lock est un lien symbolique `<host>-<pid>` ; si le PID n'est plus
 * vivant, on supprime Singleton{Lock,Cookie,Socket} sinon tout launch échoue avec
 * "Chrome introuvable" (les 3 tentatives échouent → seul le chromium bundlé absent
 * est rapporté). Sans ça, le loop unattended casse à chaque redémarrage de session.
 */
function clearStaleLock(): void {
  try {
    const target = readlinkSync(resolve(PROFILE_DIR, 'SingletonLock')); // throw si pas de lock
    const pid = Number(target.split('-').pop());
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return; } catch (e: any) { if (e?.code !== 'ESRCH') return; } // vivant -> on ne touche pas
    }
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(resolve(PROFILE_DIR, f), { force: true }); } catch { /* ignore */ }
    }
  } catch { /* pas de lock, ou best-effort */ }
}

async function launch(_opts: { headful?: boolean } = {}): Promise<BrowserContext> {
  if (_ctx) return _ctx;
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
  clearStaleLock();
  // headful sur TOUS les OS (requis par Cloudflare Turnstile) : Linux via xvfb
  // (voir bin/lk.mjs), macOS/Windows via la session bureau.
  const base = { headless: false as const, viewport: { width: 1440, height: 900 } };
  // Ordre de tentative : 1) canal chrome système (stealth max) ; 2) chemin OS
  // détecté ; 3) chromium bundlé par patchright.
  const channel = process.env.LK_BROWSER_CHANNEL || 'chrome';
  const attempts: Array<Record<string, unknown>> = [{ ...base, channel }];
  const exe = findChrome();
  if (exe) attempts.push({ ...base, executablePath: exe });
  attempts.push({ ...base });
  let lastErr: unknown;
  for (const opts of attempts) {
    try {
      _ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts as any);
      return _ctx;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Impossible de lancer un navigateur (Chrome/Chromium introuvable). ` +
      `Installe Google Chrome, ou définis LK_CHROME_PATH vers l'exécutable. Détail: ${(lastErr as any)?.message || lastErr}`,
  );
}

async function getPage(opts: { headful?: boolean } = {}): Promise<Page> {
  const ctx = await launch(opts);
  if (_page && !_page.isClosed()) return _page;
  _page = ctx.pages()[0] ?? (await ctx.newPage());
  return _page;
}

/** Cookie li_at présent dans le contexte = session active. */
export async function isLoggedIn(): Promise<boolean> {
  const ctx = await launch();
  const cookies = await ctx.cookies('https://www.linkedin.com');
  return cookies.some((c) => c.name === 'li_at' && !!c.value);
}

/** S'assure qu'une page linkedin.com est chargée (origine correcte pour les fetch Voyager). */
async function ensureOnLinkedIn(page: Page): Promise<void> {
  const url = page.url();
  if (!url.includes('linkedin.com')) {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  }
}

export interface InPageResponse {
  status: number;
  ok: boolean;
  retryAfter: string | null;
  body: string;
}

export interface InPageFetchOpts {
  method?: string; // défaut GET
  body?: string; // corps JSON déjà sérialisé (POST)
}

/**
 * Exécute un fetch Voyager (GET ou POST) DANS la page linkedin.com. Le navigateur
 * ajoute automatiquement cookie / user-agent / sec-* / referer ; on n'injecte que
 * les en-têtes applicatifs (x-li-*, accept, csrf-token lu depuis le cookie
 * JSESSIONID). Pour un POST, on pose content-type: application/json + le corps.
 */
export async function voyagerFetchInPage(
  url: string,
  appHeaders: Record<string, string>,
  opts: InPageFetchOpts = {},
): Promise<InPageResponse> {
  const page = await getPage();
  await ensureOnLinkedIn(page);

  return page.evaluate(
    async ([u, hdrs, o]: [string, Record<string, string>, InPageFetchOpts]) => {
      // csrf-token = valeur du cookie JSESSIONID (sans guillemets)
      const m = document.cookie.match(/JSESSIONID=("?)(ajax:[^";]+)\1/);
      const csrf = m ? m[2] : '';
      const headers: Record<string, string> = { ...hdrs };
      if (csrf) headers['csrf-token'] = csrf;
      const method = (o && o.method) || 'GET';
      const init: RequestInit = { method, headers, credentials: 'include' };
      if (o && o.body != null && method !== 'GET') {
        // Défaut JSON, sauf si l'appelant a déjà fixé un content-type (ex. messagerie = text/plain).
        if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json; charset=UTF-8';
        init.body = o.body;
      }
      const res = await fetch(u, init);
      const body = await res.text();
      return {
        status: res.status,
        ok: res.ok,
        retryAfter: res.headers.get('retry-after'),
        body,
      };
    },
    [url, appHeaders, opts] as [string, Record<string, string>, InPageFetchOpts],
  );
}

/**
 * PUT binaire (upload d'image) DANS la page linkedin.com. Le corps est passé en
 * base64 puis reconstruit en Uint8Array côté page. Utilisé pour l'upload média
 * messagerie (endpoint dms-uploads, même origine → cookies inclus).
 */
export async function uploadBinaryInPage(
  url: string,
  base64: string,
  contentType: string,
): Promise<{ status: number; ok: boolean; body: string }> {
  const page = await getPage();
  await ensureOnLinkedIn(page);
  return page.evaluate(
    async ([u, b64, ct]: [string, string, string]) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const res = await fetch(u, {
        method: 'PUT',
        headers: { 'content-type': ct, 'media-type-family': 'STILLIMAGE' },
        body: arr,
        credentials: 'include',
      });
      let body = '';
      try { body = await res.text(); } catch { /* corps vide sur 201 */ }
      return { status: res.status, ok: res.ok, body };
    },
    [url, base64, contentType] as [string, string, string],
  );
}

/**
 * Ouvre une fenêtre visible sur LinkedIn et attend que l'utilisateur se
 * connecte (gère 2FA/captcha manuellement). Résout quand li_at apparaît.
 */
export async function interactiveLogin(timeoutMs = 300000): Promise<boolean> {
  const ctx = await launch({ headful: true });
  const page = await getPage({ headful: true });
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  process.stderr.write('🔓 Connecte-toi dans la fenêtre (identifiants + 2FA). En attente de la session…\n');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://www.linkedin.com');
    if (cookies.some((c) => c.name === 'li_at' && c.value)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Sème le jar complet de cookies LinkedIn depuis un export TSV DevTools (fichier
 * `cookies` à la racine par défaut) dans le profil navigateur persistant.
 * C'est le chemin principal : pas besoin de login interactif.
 */
export async function seedCookiesFromFile(path: string): Promise<{ count: number; names: string[] }> {
  const cookies: PwCookie[] = loadCookiesFromFile(path);
  if (cookies.length === 0) throw new Error(`Aucun cookie linkedin.com trouvé dans ${path}`);
  const ctx = await launch();
  await ctx.addCookies(cookies as any);
  return { count: cookies.length, names: cookies.map((c) => c.name) };
}

/** Injection des cookies depuis config/cookies.json (fallback si pas de login interactif). */
export async function seedCookiesFromConfig(): Promise<void> {
  const c = getCookieConfig();
  const ctx = await launch();
  const jsession = c.jsessionid.startsWith('"') ? c.jsessionid : `"${c.jsessionid}"`;
  await ctx.addCookies([
    { name: 'li_at', value: c.li_at, domain: '.www.linkedin.com', path: '/', secure: true, httpOnly: true },
    { name: 'JSESSIONID', value: jsession, domain: '.www.linkedin.com', path: '/', secure: true },
  ]);
}

export async function closeBrowser(): Promise<void> {
  try {
    if (_ctx) await _ctx.close();
  } catch {
    /* ignore */
  } finally {
    _ctx = null;
    _page = null;
  }
}

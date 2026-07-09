/**
 * Client Voyager via transport NAVIGATEUR (Playwright).
 *
 * Logique inchangée par rapport à la version HTTP : rate-limit auto-appliqué +
 * retry/backoff exponentiel + respect des signaux serveur (429/Retry-After) +
 * sauvegarde des réponses brutes. Seul le transport change : le GET part d'un
 * vrai navigateur connecté (voir browser.ts), pas d'un fetch Node.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RAW_DIR, getSettings } from '../config.js';
import { buildAppHeaders, VoyagerContext } from './headers.js';
import { voyagerFetchInPage, isLoggedIn } from './browser.js';
import { acquire, recordSuccess, applyServerCooldown, CallKind, DailyCapReached } from '../ratelimit.js';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class TokenInvalidError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TokenInvalidError';
  }
}
export class NotLoggedInError extends Error {
  constructor() {
    super('Aucune session LinkedIn dans le navigateur. Lance `npx tsx src/cli.ts login` et connecte-toi.');
    this.name = 'NotLoggedInError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let rawCounter = 0;
function saveRaw(label: string, body: unknown): string {
  if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });
  rawCounter += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
  const file = resolve(RAW_DIR, `${stamp}_${String(rawCounter).padStart(3, '0')}_${safe}.json`);
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
  return file;
}

export interface VoyagerGetOptions {
  context: VoyagerContext;
  kind: CallKind;
  label: string;
  customReferer?: string; // ignoré en mode navigateur (le navigateur gère le referer)
  saveRawResponse?: boolean;
  verbose?: boolean;
}

export interface VoyagerResult<T = any> {
  data: T;
  rawFile?: string;
  status: number;
}

export interface VoyagerRequestOptions extends VoyagerGetOptions {
  method?: 'GET' | 'POST';
  body?: unknown; // objet -> JSON.stringify ; string -> tel quel ; POST uniquement
}

async function voyagerRequest<T = any>(url: string, opts: VoyagerRequestOptions): Promise<VoyagerResult<T>> {
  const settings = getSettings();
  const { context, kind, label } = opts;
  const method = opts.method ?? 'GET';
  const verbose = opts.verbose ?? true;
  const log = (m: string) => verbose && process.stderr.write(`[voyager] ${m}\n`);

  if (!(await isLoggedIn())) throw new NotLoggedInError();

  const appHeaders = buildAppHeaders(context);
  const bodyStr =
    opts.body == null ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);

  let attempt = 0;
  for (;;) {
    attempt += 1;

    // L'OUTIL attend ici (espacement min + cooldown serveur) — pas l'agent.
    await acquire(kind, { verbose });

    let res: { status: number; ok: boolean; retryAfter: string | null; body: string };
    try {
      res = await voyagerFetchInPage(url, appHeaders, { method, body: bodyStr });
    } catch (e: any) {
      if (attempt <= settings.retry.maxRetries) {
        const delay = backoff(attempt, settings);
        log(`erreur navigateur (${e?.message}); retry ${attempt}/${settings.retry.maxRetries} dans ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        continue;
      }
      throw e;
    }

    if (res.ok) {
      let json: any;
      try {
        json = JSON.parse(res.body);
      } catch {
        json = res.body;
      }
      const rawFile = (opts.saveRawResponse ?? true) ? saveRaw(label, json) : undefined;
      recordSuccess(kind);
      log(`${res.status} OK  ${method} ${label}  (raw: ${rawFile ? rawFile.split('/').pop() : 'non sauvé'})`);
      return { data: json as T, rawFile, status: res.status };
    }

    // --- Échec HTTP ---
    const status = res.status;
    const bodyText = res.body || '';

    if (status === 401 || (status === 403 && /CSRF|csrf|auth/i.test(bodyText))) {
      throw new TokenInvalidError(
        `HTTP ${status} — session LinkedIn invalide/expirée. Relance \`login\` pour te reconnecter. Body: ${bodyText.slice(0, 200)}`,
      );
    }

    const retryAfter = parseRetryAfter(res.retryAfter);
    if (status === 429 || retryAfter != null) {
      const cooldown = retryAfter ?? settings.defaultServerCooldownMs;
      applyServerCooldown(cooldown);
      log(`HTTP ${status} (rate-limited par le serveur). Cooldown ${Math.round(cooldown / 1000)}s posé sur disque.`);
    }

    if (RETRYABLE.has(status) && attempt <= settings.retry.maxRetries) {
      const delay = Math.max(backoff(attempt, settings), retryAfter ?? 0);
      log(`HTTP ${status}; retry ${attempt}/${settings.retry.maxRetries} dans ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      continue;
    }

    const err: any = new Error(`Voyager HTTP ${status} sur ${method} ${label}: ${bodyText.slice(0, 300)}`);
    err.status = status;
    throw err;
  }
}

export async function voyagerGet<T = any>(url: string, opts: VoyagerGetOptions): Promise<VoyagerResult<T>> {
  return voyagerRequest<T>(url, { ...opts, method: 'GET' });
}

/** POST Voyager (invitations, actions). Même rate-limit / backoff / cooldown que le GET. */
export async function voyagerPost<T = any>(url: string, opts: VoyagerRequestOptions): Promise<VoyagerResult<T>> {
  return voyagerRequest<T>(url, { ...opts, method: 'POST' });
}

function backoff(attempt: number, settings: ReturnType<typeof getSettings>): number {
  const { baseDelayMs, maxDelayMs, backoffFactor } = settings.retry;
  const d = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
  return Math.min(maxDelayMs, d) * (0.8 + Math.random() * 0.4);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export { DailyCapReached };

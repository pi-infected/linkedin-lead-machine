/**
 * Chargement de la configuration (cookies + settings) depuis le dossier config/.
 * Aucune dépendance navigateur/DB : tout vient de fichiers locaux.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
export const DATA_DIR = resolve(ROOT, 'data');
export const RAW_DIR = resolve(DATA_DIR, 'raw');
export const STATE_DIR = resolve(ROOT, 'state');
export const CONFIG_DIR = resolve(ROOT, 'config');

export interface CookieConfig {
  li_at: string;
  jsessionid: string;
  userAgent: string;
  acceptLanguage: string;
}

export interface Settings {
  minIntervalMs: { global: number; search: number; comments: number; profile: number; invite: number; connections: number };
  jitterMs: number;
  // Jitter spécifique par type d'appel (surcharge jitterMs). Sert surtout aux invitations,
  // où l'on veut un espacement humain de 60-120s (minInterval 60s + jitter jusqu'à 60s).
  jitterMsByKind?: Partial<Record<'search' | 'comments' | 'profile' | 'invite' | 'connections', number>>;
  dailyCaps: { voyager: number; profile: number; searchPeople: number; invite: number; connections: number };
  retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number; backoffFactor: number };
  defaultServerCooldownMs: number;
}

const DEFAULT_SETTINGS: Settings = {
  minIntervalMs: { global: 4000, search: 9000, comments: 3000, profile: 14000, invite: 60000, connections: 9000 },
  jitterMs: 5000,
  jitterMsByKind: { invite: 60000 },
  dailyCaps: { voyager: 300, profile: 50, searchPeople: 100, invite: 20, connections: 100 },
  retry: { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30000, backoffFactor: 2 },
  defaultServerCooldownMs: 90000,
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

let _cookies: CookieConfig | null = null;
export function getCookieConfig(): CookieConfig {
  if (_cookies) return _cookies;
  const path = resolve(CONFIG_DIR, 'cookies.json');
  if (!existsSync(path)) {
    throw new Error(
      `config/cookies.json introuvable. Copie config/cookies.example.json -> config/cookies.json et remplis li_at + jsessionid.`,
    );
  }
  const c = readJson<CookieConfig>(path);
  if (!c.li_at || c.li_at.includes('PASTE')) throw new Error('cookies.json: li_at manquant ou non rempli.');
  if (!c.jsessionid || c.jsessionid.includes('0000000000')) throw new Error('cookies.json: jsessionid manquant ou non rempli.');
  _cookies = c;
  return c;
}

let _settings: Settings | null = null;
export function getSettings(): Settings {
  if (_settings) return _settings;
  const path = resolve(CONFIG_DIR, 'settings.json');
  if (existsSync(path)) {
    const override = readJson<Partial<Settings>>(path);
    _settings = deepMerge(DEFAULT_SETTINGS, override);
  } else {
    _settings = DEFAULT_SETTINGS;
  }
  return _settings;
}

function deepMerge<T>(base: T, over: any): T {
  if (over == null || typeof over !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;
    const bv = (base as any)?.[k];
    const ov = over[k];
    out[k] = bv && typeof bv === 'object' && !Array.isArray(bv) ? deepMerge(bv, ov) : ov;
  }
  return out as T;
}

/** Cookies au format tableau attendu par buildHeaders (name/value). */
export function getCookieArray(): Array<{ name: string; value: string }> {
  const c = getCookieConfig();
  const jsession = c.jsessionid.startsWith('"') ? c.jsessionid : `"${c.jsessionid}"`;
  return [
    { name: 'li_at', value: c.li_at },
    { name: 'JSESSIONID', value: jsession },
  ];
}

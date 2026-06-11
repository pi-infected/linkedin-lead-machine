/**
 * Importe un export TSV de cookies Chrome DevTools (Application > Cookies, copier/coller).
 * Colonnes observées : Name, Value, Domain, Path, Expires, Size, HttpOnly(✓), Secure(✓),
 * SameSite, [Partition], [CrossSite], Priority, ...
 *
 * On ne garde que les cookies du domaine linkedin.com et on les convertit au format
 * attendu par Playwright (context.addCookies).
 */
import { readFileSync } from 'node:fs';

export interface PwCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // epoch secondes ; -1 / absent = cookie de session
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

function toSameSite(raw: string | undefined): 'Strict' | 'Lax' | 'None' | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  if (v === 'none') return 'None';
  return undefined;
}

function toExpires(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s || /session/i.test(s)) return undefined;
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  const n = Number(s);
  if (!Number.isNaN(n)) return n > 1e12 ? Math.floor(n / 1000) : n; // ms vs s
  return undefined;
}

const CHECK = (cell: string | undefined) => !!cell && /[✓✔xX✅]/.test(cell);

/** Parse le TSV et renvoie les cookies LinkedIn au format Playwright. */
export function parseCookiesTsv(text: string, domainFilter = 'linkedin.com'): PwCookie[] {
  const out: PwCookie[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const [name, value, domain, path, expires, , httpOnlyCol, secureCol, sameSiteCol] = cols;
    if (!name || value === undefined || !domain) continue;
    if (!domain.includes(domainFilter)) continue;
    if (name === 'Name' && value === 'Value') continue; // ligne d'en-tête éventuelle

    const sameSite = toSameSite(sameSiteCol);
    const secure = CHECK(secureCol) || sameSite === 'None'; // None impose Secure
    const cookie: PwCookie = {
      name: name.trim(),
      value: value, // ne PAS trim la value (peut contenir des = / espaces signifiants ? non, mais on garde brut)
      domain: domain.trim(),
      path: (path && path.trim()) || '/',
      httpOnly: CHECK(httpOnlyCol),
      secure,
    };
    const exp = toExpires(expires);
    if (exp !== undefined) cookie.expires = exp;
    if (sameSite) cookie.sameSite = sameSite;
    out.push(cookie);
  }
  // Dédup par name+domain+path (les copier/coller multiples créent des doublons) — on garde la dernière occurrence.
  const map = new Map<string, PwCookie>();
  for (const c of out) map.set(`${c.name}|${c.domain}|${c.path}`, c);
  return [...map.values()];
}

export function loadCookiesFromFile(path: string, domainFilter = 'linkedin.com'): PwCookie[] {
  return parseCookiesTsv(readFileSync(path, 'utf8'), domainFilter);
}

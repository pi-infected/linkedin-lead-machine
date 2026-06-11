/**
 * Rate limiter PERSISTANT et auto-appliqué.
 *
 * Principe (exigence produit) : ce n'est PAS à l'agent d'attendre. C'est l'outil
 * qui enforce les timings, en s'appuyant sur deux sources d'autorité :
 *
 *   1. Un espacement minimal côté client (min interval + jitter) entre chaque
 *      appel Voyager, persisté sur disque -> même si le CLI est relancé en
 *      rafale dans des process séparés, l'état partagé force l'attente.
 *   2. Le SERVEUR : à la moindre réponse 429 / Retry-After, on pose un
 *      "cooldownUntil" sur disque que TOUS les appels suivants respectent.
 *      C'est le serveur qui dicte quand on peut repartir.
 *
 * + plafonds quotidiens (reset minuit local) pour rester sous le radar.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_DIR, getSettings } from './config.js';

export type CallKind = 'search' | 'comments' | 'profile';

interface State {
  lastCallAt: Record<string, number>; // 'global' | kind -> epoch ms
  cooldownUntil: number; // epoch ms ; appels bloqués jusque-là (signal serveur)
  daily: { date: string; voyager: number; profile: number; searchPeople: number };
}

const STATE_PATH = resolve(STATE_DIR, 'ratelimit.json');

function todayStr(): string {
  // Date locale YYYY-MM-DD
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyState(): State {
  return {
    lastCallAt: {},
    cooldownUntil: 0,
    daily: { date: todayStr(), voyager: 0, profile: 0, searchPeople: 0 },
  };
}

function loadState(): State {
  try {
    if (!existsSync(STATE_PATH)) return emptyState();
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
    // Reset quotidien
    if (s.daily?.date !== todayStr()) {
      s.daily = { date: todayStr(), voyager: 0, profile: 0, searchPeople: 0 };
    }
    s.lastCallAt ||= {};
    s.cooldownUntil ||= 0;
    return s;
  } catch {
    return emptyState();
  }
}

function saveState(s: State): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_PATH); // écriture atomique
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
}

export class DailyCapReached extends Error {
  constructor(public bucket: string, public count: number, public cap: number) {
    super(`Plafond quotidien atteint pour "${bucket}": ${count}/${cap}. Réessaie après minuit (heure locale).`);
    this.name = 'DailyCapReached';
  }
}

/** Comptage quotidien que consomme chaque type d'appel. */
function bucketsFor(kind: CallKind): Array<'voyager' | 'profile' | 'searchPeople'> {
  if (kind === 'profile') return ['voyager', 'profile'];
  return ['voyager']; // search + comments comptent dans le quota voyager global
}

export interface AcquireResult {
  waitedMs: number;
  dailyAfter: State['daily'];
}

/**
 * À appeler AVANT chaque requête réseau. Vérifie les plafonds, attend le
 * cooldown serveur, attend l'espacement min, puis marque l'instant d'appel.
 * Lève DailyCapReached si le quota du jour est épuisé.
 */
export async function acquire(kind: CallKind, opts: { verbose?: boolean } = {}): Promise<AcquireResult> {
  const settings = getSettings();
  const log = (m: string) => opts.verbose && process.stderr.write(`[ratelimit] ${m}\n`);

  // Vérifier les plafonds quotidiens (sur état frais)
  {
    const s = loadState();
    for (const b of bucketsFor(kind)) {
      const cap = settings.dailyCaps[b];
      if (s.daily[b] >= cap) throw new DailyCapReached(b, s.daily[b], cap);
    }
  }

  let totalWaited = 0;

  // Boucle : on relit l'état à chaque tour car un autre process a pu écrire un cooldown.
  for (;;) {
    const s = loadState();
    const now = Date.now();

    // 1) Cooldown serveur (429/Retry-After) — autorité supérieure
    if (s.cooldownUntil > now) {
      const wait = s.cooldownUntil - now;
      log(`cooldown serveur actif, attente ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
      totalWaited += wait;
      continue;
    }

    // 2) Espacement minimal (global + spécifique au type) + jitter
    const minGlobal = settings.minIntervalMs.global;
    const minKind = settings.minIntervalMs[kind] ?? 0;
    const lastGlobal = s.lastCallAt['global'] ?? 0;
    const lastKind = s.lastCallAt[kind] ?? 0;
    const dueGlobal = lastGlobal + minGlobal;
    const dueKind = lastKind + minKind;
    const due = Math.max(dueGlobal, dueKind);
    const jitter = Math.random() * settings.jitterMs;

    if (now < due) {
      const wait = due - now + jitter;
      log(`espacement min, attente ${(wait / 1000).toFixed(1)}s (kind=${kind})`);
      await sleep(wait);
      totalWaited += wait;
      continue; // re-vérifie (un cooldown a pu apparaître entre-temps)
    } else if (jitter > 0) {
      // Même quand on est "en règle", on ajoute un petit jitter humain.
      await sleep(jitter);
      totalWaited += jitter;
    }

    // 3) On marque l'instant d'appel et on sort
    const t = Date.now();
    const s2 = loadState();
    s2.lastCallAt['global'] = t;
    s2.lastCallAt[kind] = t;
    saveState(s2);
    return { waitedMs: totalWaited, dailyAfter: s2.daily };
  }
}

/** À appeler APRÈS une requête réussie pour incrémenter les compteurs quotidiens. */
export function recordSuccess(kind: CallKind): State['daily'] {
  const s = loadState();
  for (const b of bucketsFor(kind)) s.daily[b] = (s.daily[b] ?? 0) + 1;
  saveState(s);
  return s.daily;
}

/** Pose un cooldown imposé par le serveur (429 / Retry-After). */
export function applyServerCooldown(ms: number): number {
  const s = loadState();
  const until = Date.now() + Math.max(0, ms);
  if (until > s.cooldownUntil) s.cooldownUntil = until;
  saveState(s);
  return s.cooldownUntil;
}

export function getStatus(): { daily: State['daily']; cooldownRemainingMs: number; lastCallAt: Record<string, number> } {
  const s = loadState();
  return {
    daily: s.daily,
    cooldownRemainingMs: Math.max(0, s.cooldownUntil - Date.now()),
    lastCallAt: s.lastCallAt,
  };
}

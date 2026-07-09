/**
 * Profil de campagne ACTIF — c'est ici que vit l'« ICP » (Ideal Customer Profile).
 *
 * Rien n'est codé en dur pour un cas d'usage précis : l'AGENT discute avec
 * l'utilisateur, en déduit une cible, et écrit ce profil via `lk profile set`.
 * Le moteur (scoring, classification, export) lit ce profil. L'utilisateur final
 * n'a jamais à éditer de JSON ni à coder — c'est l'agent qui le compose.
 *
 * Persisté dans state/profile.json (un seul profil actif à la fois).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_DIR } from './config.js';

/** Une règle de scoring : si un des patterns matche le texte du lead, +weight et on pose le tag. */
export interface ScoreRule {
  tag: string;
  weight: number;
  patterns: string[]; // chaînes regex (insensibles à la casse) ; littéral si la regex est invalide
}

/** Un bucket de classification : 1er groupe dont un pattern matche la headline gagne. */
export interface Group {
  name: string;
  patterns: string[];
}

export interface Profile {
  /** Description libre de la cible (mémo de l'agent, non utilisée par le moteur). */
  icp: string;
  /** Mots-clés de recherche actifs ; servent aussi de fallback de scoring (recouvrement). */
  keywords: string[];
  /** Filtre géo LinkedIn (urn:li:geo id) ou null pour mondial. */
  geoUrn: string | null;
  /** Libellé lisible du filtre géo (ex: "United States"), pour la colonne CSV. */
  geoLabel: string | null;
  /** Règles de scoring. Vide => scoring par recouvrement avec `keywords`. */
  scoreRules: ScoreRule[];
  /** Buckets de classification ordonnés. Vide => DEFAULT_GROUPS (niveaux de rôle génériques). */
  groups: Group[];
  /** Seuil de score par défaut à l'export. */
  minScore: number;
}

/**
 * Classification par défaut, par NIVEAU DE RÔLE — universelle B2B, pas liée à un
 * cas d'usage. L'agent peut la remplacer par des buckets sur mesure.
 *  - decision_maker : qui décide / adopte / achète (fondateur, C-level, VP, head, director…)
 *  - practitioner   : qui utilise l'outil au quotidien (ingénieur, dev, scientist, IC…)
 *  - other          : tout le reste (fallback implicite, pas besoin de le lister)
 */
export const DEFAULT_GROUPS: Group[] = [
  {
    name: 'decision_maker',
    patterns: [
      'founder', 'co-?founder', 'cofounder',
      '\\b(ceo|cto|coo|cio|cfo|cmo|cpo|cdo|caio)\\b', 'chief',
      '\\b(vp|svp|evp|vice[- ]president)\\b', 'head of', '\\b(director|dir\\.)\\b',
      'owner', 'president', 'managing (director|partner)', 'general manager', '\\bgm\\b',
      '(engineering|product|technology|ai|ml|data) manager', '\\bpartner\\b',
    ],
  },
  {
    name: 'practitioner',
    patterns: [
      'engineer', 'engineering', 'developer', '\\bdev\\b', 'programmer', 'coder',
      'data scientist', 'scientist', 'researcher', 'architect',
      '\\b(swe|sde|sdet|mle|mlops|llmops|devops)\\b', 'member of technical staff', '\\bmts\\b',
      'analyst', 'specialist', 'practitioner', 'intern', 'student', 'new grad',
    ],
  },
];

const PROFILE_PATH = resolve(STATE_DIR, 'profile.json');
let _cache: Profile | null = null;

function normalize(p: any): Profile {
  return {
    icp: typeof p?.icp === 'string' ? p.icp : '',
    keywords: Array.isArray(p?.keywords) ? dedupe(p.keywords.filter((k: any) => typeof k === 'string')) : [],
    geoUrn: p?.geoUrn ?? null,
    geoLabel: p?.geoLabel ?? null,
    scoreRules: Array.isArray(p?.scoreRules) ? p.scoreRules : [],
    groups: Array.isArray(p?.groups) && p.groups.length ? p.groups : DEFAULT_GROUPS,
    minScore: typeof p?.minScore === 'number' ? p.minScore : 0,
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

export function getProfile(): Profile {
  if (_cache) return _cache;
  if (existsSync(PROFILE_PATH)) {
    try {
      _cache = normalize(JSON.parse(readFileSync(PROFILE_PATH, 'utf8')));
    } catch {
      _cache = normalize({});
    }
  } else {
    _cache = normalize({});
  }
  return _cache;
}

/**
 * Fusionne un patch dans le profil actif et le persiste.
 * `mergeKeywords` (défaut true) ajoute aux mots-clés existants au lieu de remplacer —
 * utile pour accumuler le vocabulaire de recherche au fil des campagnes.
 */
export function saveProfile(patch: Partial<Profile>, opts: { mergeKeywords?: boolean } = {}): Profile {
  const cur = getProfile();
  const mergeKeywords = opts.mergeKeywords !== false;
  const keywords = patch.keywords
    ? mergeKeywords
      ? dedupe([...cur.keywords, ...patch.keywords])
      : dedupe(patch.keywords)
    : cur.keywords;
  const next = normalize({ ...cur, ...patch, keywords });
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  _cache = next;
  return next;
}

/** Réinitialise le profil actif (cible vierge). */
export function resetProfile(): Profile {
  _cache = null;
  if (existsSync(STATE_DIR)) writeFileSync(PROFILE_PATH, JSON.stringify(normalize({}), null, 2) + '\n', 'utf8');
  return getProfile();
}

export const PROFILE_FILE = PROFILE_PATH;

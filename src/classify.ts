/**
 * Classe un lead dans un GROUPE, à partir de la headline uniquement (pas de profil).
 *
 * Les groupes viennent du profil actif (voir profile.ts). Par défaut = niveaux de
 * rôle génériques (decision_maker / practitioner / other), universels et réutilisables.
 * L'agent peut définir des buckets sur mesure pour n'importe quel cas d'usage.
 *
 * 1er groupe dont un pattern matche la headline gagne ; sinon 'other'.
 */
import { getProfile, Group } from './profile.js';

/** Nom de groupe dynamique (selon le profil). */
export type Role = string;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return new RegExp(escapeRegExp(p), 'i');
    }
  });
}

export function classify(headline?: string, groups?: Group[]): Role {
  const h = (headline || '').trim();
  if (!h) return 'other';
  const buckets = groups ?? getProfile().groups;
  for (const g of buckets) {
    if (compile(g.patterns).some((rx) => rx.test(h))) return g.name;
  }
  return 'other';
}

/** Alias rétro-compatible. */
export const classifyRole = classify;

/**
 * Scoring de lead — GÉNÉRIQUE, piloté par le profil actif (voir profile.ts).
 *
 * On NE regarde PAS les profils LinkedIn. Signal = headline (tagline) + texte des
 * posts/commentaires. Deux modes :
 *  1. `scoreRules` définies dans le profil  -> chaque règle qui matche ajoute son poids + un tag.
 *  2. aucune règle (cas par défaut)         -> scoring par RECOUVREMENT avec les mots-clés de la
 *     campagne : +1 par mot-clé dont tous les termes significatifs apparaissent dans le texte.
 *
 * Aucune règle codée en dur pour un cas d'usage : tout vient du profil que l'agent compose.
 */
import { getProfile, ScoreRule } from './profile.js';

export interface LeadScore {
  score: number;
  tags: string[];
}

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

function keywordOverlap(blob: string, keywords: string[]): LeadScore {
  const low = blob.toLowerCase();
  const tags: string[] = [];
  let score = 0;
  for (const kw of keywords) {
    const words = kw.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (words.length && words.every((w) => low.includes(w))) {
      score += 1;
      tags.push(kw);
    }
  }
  return { score, tags };
}

/** Score un lead à partir de ses textes (headline + extraits). `rules` surcharge le profil si fourni. */
export function scoreLead(texts: string[], rules?: ScoreRule[]): LeadScore {
  const profile = getProfile();
  const blob = texts.filter(Boolean).join('  ||  ');
  const activeRules = rules ?? profile.scoreRules;
  if (activeRules.length === 0) {
    return keywordOverlap(blob, profile.keywords);
  }
  const tags: string[] = [];
  let score = 0;
  for (const rule of activeRules) {
    if (compile(rule.patterns).some((rx) => rx.test(blob))) {
      score += rule.weight;
      tags.push(rule.tag);
    }
  }
  return { score, tags };
}

/**
 * Un post/commentaire vaut-il le coup d'aller chercher ses commentateurs ?
 * Seuil = max(1, minScore du profil) pour rester pertinent quel que soit le mode de scoring.
 */
export function postIsRelevant(text: string, headline?: string): boolean {
  const min = Math.max(1, getProfile().minScore || 0);
  return scoreLead([text, headline || '']).score >= min;
}

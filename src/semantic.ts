/**
 * Pont vers le score sémantique potion (model2vec, Python). Sert à créditer la
 * DOULEUR exprimée dans le texte (commentaire + headline) au-delà du simple
 * match de mots-clés : similarité cosinus au concept-douleur de l'ICP.
 *
 * N'appelle AUCUN endpoint LinkedIn : lit des textes déjà stockés (evidence),
 * calcule en local. Le modèle est chargé par model2vec (cache local, sinon
 * téléchargé à la demande).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from './config.js';

export interface SemanticResult {
  ok: boolean;
  sims: Record<string, number>; // key -> cosine 0..1
  error?: string;
}

/** Phrases-graines décrivant la douleur ciblée (multilingue : le modèle l'est,
 * et les commentaires mêlent EN/FR). Ajuste ici le concept si la cible change. */
export const PAIN_REFS: string[] = [
  'token costs are too high',
  'reduce LLM token cost',
  'I hit my Claude Code usage limit',
  'my Anthropic API bill is expensive',
  'autonomous coding agents burn through tokens',
  'cut AI inference cost without slowing engineers',
  'optimize prompt and context window token usage',
  'rate limited on my AI coding agent',
  'les coûts de tokens sont trop élevés',
  "réduire la facture d'API IA",
  'agents de code autonomes très gros consommateurs de tokens',
];

/**
 * Calcule la similarité de chaque item au centroïde des `refs`. Renvoie
 * `ok:false` (sans lever) si Python/model2vec indisponible, pour que l'appelant
 * dégrade proprement.
 */
export function semanticSimilarities(
  items: { key: string; text: string }[],
  refs: string[] = PAIN_REFS,
): SemanticResult {
  if (!items.length) return { ok: true, sims: {} };
  const script = resolve(ROOT, 'scripts', 'semantic_score.py');
  const input = JSON.stringify({ refs, items });
  const py = process.env.PYTHON || 'python3';
  const res = spawnSync(py, [script], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  if (res.error) return { ok: false, sims: {}, error: `${py}: ${res.error.message}` };
  if (res.status !== 0) {
    const err = (res.stderr || '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, sims: {}, error: err || `exit ${res.status}` };
  }
  try {
    return { ok: true, sims: JSON.parse(res.stdout || '{}') };
  } catch (e: any) {
    return { ok: false, sims: {}, error: `parse: ${e?.message || e}` };
  }
}

/** Bonus de score entier dérivé d'une similarité 0..1 : rien sous `floor`,
 * puis pente `gain`, plafonné à `cap`. */
export function semanticBonus(sim: number, floor = 0.25, gain = 12, cap = 6): number {
  if (!(sim > floor)) return 0;
  return Math.min(cap, Math.round((sim - floor) * gain));
}

/**
 * Stockage des résultats en fichiers JSONL, pour que l'agent lise par morceaux
 * (personnes / posts / commentaires séparément) sans tout charger en contexte.
 *
 * - data/people.jsonl   : leads dédupliqués (1 ligne = 1 personne) + score
 * - data/posts.jsonl     : posts trouvés (1 ligne = 1 post)
 * - data/comments.jsonl  : commentaires trouvés (1 ligne = 1 commentaire)
 * - data/raw/*.json      : réponses Voyager brutes (pour audit / affinage parsers)
 *
 * Score et groupe sont calculés via le PROFIL ACTIF (profile.ts) — rien de codé en dur.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import { Person, PostRecord, CommentRecord } from './voyager/parse.js';
import { scoreLead } from './score.js';
import { classify, Role } from './classify.js';

export interface LeadRecord extends Person {
  score: number;
  tags: string[];
  evidence: string[]; // extraits (headline + bouts de texte) justifiant le lead
  firstSeen: string;
  resolved?: boolean; // URL vanity confirmée
  geo?: string | null; // libellé géo confirmé (via recherche filtrée par localisation), sinon absent
  invitationStatus?: 'pending' | 'accepted' | 'withdrawn'; // suivi de la demande de connexion
  invitedAt?: string; // ISO : quand l'invitation est partie
  acceptedAt?: string; // ISO : quand l'acceptation a été détectée (via check-accepted)
}

function ensure() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}
function path(name: string) {
  return resolve(DATA_DIR, name);
}
function readJsonl<T>(name: string): T[] {
  const p = path(name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
function writeJsonl<T>(name: string, rows: T[]) {
  ensure();
  writeFileSync(path(name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function keyOf(p: Person): string {
  return (p.profileUrn || p.profileUrl || p.name.toLowerCase()).trim();
}

/** Upsert d'un lead avec fusion d'infos et accumulation des preuves. Renvoie isNew. */
export function upsertLead(
  person: Person,
  evidence: string[],
  opts: { geo?: string | null } = {},
): { isNew: boolean; record: LeadRecord } {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  const k = keyOf(person);
  const idx = leads.findIndex((l) => keyOf(l) === k);
  const ev = evidence.filter(Boolean);

  if (idx === -1) {
    const sc = scoreLead([person.headline, ...ev].filter(Boolean) as string[]);
    const rec: LeadRecord = {
      ...person,
      score: sc.score,
      tags: sc.tags,
      evidence: dedupeStr(ev).slice(0, 8),
      firstSeen: new Date().toISOString(),
      geo: opts.geo || undefined,
    };
    leads.push(rec);
    writeJsonl('people.jsonl', leads);
    return { isNew: true, record: rec };
  }

  const prev = leads[idx];
  const mergedEvidence = dedupeStr([...prev.evidence, ...ev]).slice(0, 8);
  const sc = scoreLead([prev.headline || person.headline, ...mergedEvidence].filter(Boolean) as string[]);
  const merged: LeadRecord = {
    ...prev,
    headline: prev.headline || person.headline,
    profileUrl: prev.profileUrl || person.profileUrl,
    profileUrn: prev.profileUrn || person.profileUrn,
    evidence: mergedEvidence,
    score: sc.score,
    tags: sc.tags,
    geo: prev.geo || opts.geo || undefined,
    degree: prev.degree ?? person.degree,
  };
  leads[idx] = merged;
  writeJsonl('people.jsonl', leads);
  return { isNew: false, record: merged };
}

/** Recalcule score + tags de TOUS les leads stockés contre le profil actif (après changement d'ICP). */
export function rescoreAll(): number {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  for (const l of leads) {
    const sc = scoreLead([l.headline || '', ...(l.evidence || [])].filter(Boolean) as string[]);
    l.score = sc.score;
    l.tags = sc.tags;
  }
  writeJsonl('people.jsonl', leads);
  return leads.length;
}

// Colonnes de SUIVI en tête (profil + invité ? + accepté ?) pour un suivi manuel simple.
const CSV_HEAD = ['name', 'group', 'geo', 'profileUrl', 'Invité ?', 'Accepté ?', 'score', 'tags', 'headline', 'source', 'evidence'];
/** "x" si une invitation a été envoyée (horodatage ou statut posé). */
export function invitedMark(l: LeadRecord): string {
  return l.invitedAt || l.invitationStatus === 'pending' || l.invitationStatus === 'accepted' ? 'x' : '';
}
/** "x" si la personne est désormais une relation (invitation acceptée ou déjà 1er degré). */
export function acceptedMark(l: LeadRecord): string {
  return l.invitationStatus === 'accepted' || l.degree === 1 ? 'x' : '';
}
/** Échappe une valeur pour une cellule CSV (guillemets doublés, retours-ligne aplatis). */
export function csvEscape(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}
function csvRow(l: LeadRecord, group: Role): string {
  const esc = csvEscape;
  return [
    l.name,
    group,
    l.geo || '',
    l.profileUrl || '',
    invitedMark(l),
    acceptedMark(l),
    l.score,
    l.tags.join('|'),
    l.headline,
    l.source,
    (l.evidence || []).join(' ⋮ ').slice(0, 280),
  ]
    .map(esc)
    .join(',');
}
function writeCsv(name: string, leads: LeadRecord[], groupOf: (l: LeadRecord) => Role): { path: string; count: number } {
  const rows = leads.map((l) => csvRow(l, groupOf(l)));
  const p = resolve(DATA_DIR, name);
  writeFileSync(p, [CSV_HEAD.join(','), ...rows].join('\n') + '\n', 'utf8');
  return { path: p, count: leads.length };
}

/** Slugifie un nom de groupe pour le nom de fichier (leads-<slug>.csv). */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}

export interface ExportResult {
  combined: { path: string; count: number };
  groups: Record<string, { path: string; count: number }>;
  /** Découpe automatique par statut de connexion (présente seulement si le degré est connu). */
  connection?: { connected: { path: string; count: number }; notConnected: { path: string; count: number } };
}

/**
 * Exporte les leads. Écrit toujours data/leads.csv (combiné), et si `split` (défaut),
 * un fichier par GROUPE présent : data/leads-<groupe>.csv. Le groupe vient de la
 * classification du profil actif — donc dynamique selon l'ICP, pas figé.
 * Tri : géo-confirmé d'abord, puis score décroissant.
 */
export function exportLeads(opts: { minScore?: number; split?: boolean } = {}): ExportResult {
  const minScore = opts.minScore ?? 0;
  const split = opts.split !== false;
  const leads = selectLeads(minScore);
  const groupOf = (l: LeadRecord) => classify(l.headline);
  const combined = writeCsv('leads.csv', leads, groupOf);

  const groups: Record<string, { path: string; count: number }> = {};
  if (split) {
    const byGroup = new Map<string, LeadRecord[]>();
    for (const l of leads) {
      const g = groupOf(l);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(l);
    }
    for (const [g, rows] of byGroup) {
      groups[g] = writeCsv(`leads-${slug(g)}.csv`, rows, () => g);
    }
  }

  // Découpe automatique connecté / non-connecté (1er degré vs reste), si LinkedIn a fourni le degré.
  let connection: ExportResult['connection'];
  if (split && leads.some((l) => l.degree !== undefined)) {
    const conn = leads.filter((l) => l.degree === 1);
    const noconn = leads.filter((l) => l.degree !== undefined && l.degree !== 1);
    connection = {
      connected: writeCsv('leads-connected.csv', conn, groupOf),
      notConnected: writeCsv('leads-not-connected.csv', noconn, groupOf),
    };
  }
  return { combined, groups, connection };
}

/** Garde les leads géo-confirmés (même score faible) + le reste au-dessus du seuil. Tri géo puis score. */
function selectLeads(minScore: number): LeadRecord[] {
  return getLeads()
    .filter((l) => l.score >= minScore || !!l.geo)
    .sort((a, b) => {
      const g = Number(!!b.geo) - Number(!!a.geo);
      return g !== 0 ? g : b.score - a.score;
    });
}

/** Marque un lead comme résolu (URL vanity confirmée). */
export function markResolved(key: string, profileUrl: string): boolean {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  const idx = leads.findIndex((l) => keyOf(l) === key || l.profileUrn === key || l.name.toLowerCase() === key.toLowerCase());
  if (idx === -1) return false;
  leads[idx].profileUrl = profileUrl;
  leads[idx].resolved = true;
  writeJsonl('people.jsonl', leads);
  return true;
}

/* ---------- invitations / acceptations ---------- */

export interface InvitableOpts {
  minScore?: number;
  group?: string;
  limit?: number;
}

/** Leads éligibles à une demande de connexion : ont un URN, pas déjà connectés (degree≠1), pas déjà invités. Tri score décroissant. */
export function getInvitable(opts: InvitableOpts = {}): LeadRecord[] {
  const minScore = opts.minScore ?? 0;
  let leads = getLeads().filter(
    (l) =>
      !!l.profileUrn &&
      /ACoAA[A-Za-z0-9_-]+/.test(l.profileUrn) && // URN réellement invitable (id membre valide)
      l.name !== 'LinkedIn Member' && // profils anonymisés : pas d'invitation possible
      l.degree !== 1 &&
      !l.invitationStatus &&
      l.score >= minScore,
  );
  if (opts.group) leads = leads.filter((l) => classify(l.headline) === opts.group);
  leads.sort((a, b) => b.score - a.score);
  return opts.limit ? leads.slice(0, opts.limit) : leads;
}

/** Leads dont l'invitation est partie et en attente de réponse. */
export function getPendingInvites(): LeadRecord[] {
  return getLeads().filter((l) => l.invitationStatus === 'pending');
}

/** Marque un lead comme invité (invitation envoyée). Clé = profileUrn ou keyOf. */
export function markInvited(key: string, at: string): boolean {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  const idx = leads.findIndex((l) => keyOf(l) === key || l.profileUrn === key);
  if (idx === -1) return false;
  leads[idx].invitationStatus = 'pending';
  leads[idx].invitedAt = at;
  writeJsonl('people.jsonl', leads);
  return true;
}

/** Marque en lot les leads acceptés (par profileUrn) : status=accepted, degree=1, acceptedAt. Renvoie le nb modifié. */
export function markAcceptedMany(profileUrns: string[], at: string): number {
  const set = new Set(profileUrns.filter(Boolean));
  if (!set.size) return 0;
  const leads = readJsonl<LeadRecord>('people.jsonl');
  let n = 0;
  for (const l of leads) {
    if (l.profileUrn && set.has(l.profileUrn) && l.invitationStatus !== 'accepted') {
      l.invitationStatus = 'accepted';
      l.acceptedAt = at;
      l.degree = 1;
      n++;
    }
  }
  if (n) writeJsonl('people.jsonl', leads);
  return n;
}

export function appendPost(post: PostRecord) {
  ensure();
  appendFileSync(path('posts.jsonl'), JSON.stringify({ ...post, ts: new Date().toISOString() }) + '\n', 'utf8');
}
export function appendComment(c: CommentRecord) {
  ensure();
  appendFileSync(path('comments.jsonl'), JSON.stringify({ ...c, ts: new Date().toISOString() }) + '\n', 'utf8');
}

export function getLeads(): LeadRecord[] {
  return readJsonl<LeadRecord>('people.jsonl');
}
export function getPosts(): (PostRecord & { ts: string })[] {
  return readJsonl('posts.jsonl');
}

function dedupeStr(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

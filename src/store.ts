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
  semanticSim?: number; // similarité cosinus au concept-douleur (0..1), via potion — crédite l'intent
  patternScore?: number; // score mots-clés seul (avant bonus sémantique), pour idempotence
  firstSeen: string;
  segment?: string; // hypothèse de segment testée (ex. "S2") — pour tracker les expériences
  resolved?: boolean; // URL vanity confirmée
  geo?: string | null; // libellé géo confirmé (via recherche filtrée par localisation), sinon absent
  invitationStatus?: 'pending' | 'accepted' | 'withdrawn'; // suivi de la demande de connexion
  invitedAt?: string; // ISO : quand l'invitation est partie
  acceptedAt?: string; // ISO : quand l'acceptation a été détectée (via check-accepted)
  messageStatus?: 'sent' | 'failed'; // suivi du 1er message (message normal ou InMail)
  messagedAt?: string; // ISO : quand le message est parti
  messageChannel?: 'message' | 'inmail'; // canal utilisé : message normal (1er degré) ou InMail (non connecté)
  lastRelCheckAt?: string; // ISO : dernière vérification de relation (check-accepted) — sert à la rotation du pool
  followupStatus?: 'sent'; // suivi de la relance (au moins une relance envoyée)
  followupAt?: string; // ISO : quand la DERNIÈRE relance est partie
  followupCount?: number; // nombre de relances déjà envoyées
  conversationId?: string; // id de thread messagerie (2-…), capturé à l'envoi — pour la détection de réponse
  repliedStatus?: 'replied'; // le lead a répondu (message entrant détecté)
  repliedAt?: string; // ISO : quand la réponse a été détectée
  repliedText?: string; // texte du/des message(s) entrant(s) (pour juger l'intérêt)
  lastReplyCheckAt?: string; // ISO : dernière vérification de réponse — rotation du check-replies
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
  opts: { geo?: string | null; segment?: string } = {},
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
      segment: opts.segment || undefined,
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
    segment: prev.segment || opts.segment || undefined, // 1er segment qui l'a trouvé gagne
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
const CSV_HEAD = ['name', 'group', 'geo', 'profileUrl', 'Invité ?', 'Accepté ?', 'Message envoyé ?', 'Répondu ?', 'Follow-up ?', 'score', 'tags', 'headline', 'source', 'evidence'];
/** "x" si une invitation a été envoyée (horodatage ou statut posé). */
export function invitedMark(l: LeadRecord): string {
  return l.invitedAt || l.invitationStatus === 'pending' || l.invitationStatus === 'accepted' ? 'x' : '';
}
/** "x" si la personne est désormais une relation (invitation acceptée ou déjà 1er degré). */
export function acceptedMark(l: LeadRecord): string {
  return l.invitationStatus === 'accepted' || l.degree === 1 ? 'x' : '';
}
/** "x" si un 1er message a été envoyé (message normal ou InMail) ; "inmail"/"msg" suffixé si le canal est connu. */
export function messagedMark(l: LeadRecord): string {
  if (l.messageStatus !== 'sent' && !l.messagedAt) return '';
  return l.messageChannel === 'inmail' ? 'x (inmail)' : 'x';
}
/** Nombre de relances envoyées (ex. "2"), sinon vide. */
export function followupMark(l: LeadRecord): string {
  if (l.followupCount) return String(l.followupCount);
  return l.followupStatus === 'sent' || l.followupAt ? 'x' : '';
}
/** "x" si le lead a répondu (message entrant détecté via check-replies). */
export function repliedMark(l: LeadRecord): string {
  return l.repliedStatus === 'replied' || l.repliedAt ? 'x' : '';
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
    messagedMark(l),
    repliedMark(l),
    followupMark(l),
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
/**
 * Promeut un lead d'un URN non-invitable (urn:li:member:NNNN, issu des
 * commentaires) vers son URN fsd_profile invitable (ACoAA...). Optionnellement
 * fixe le degré. Marque `resolved` pour ne pas le re-traiter.
 */
export function promoteLeadUrn(oldKey: string, newProfileUrn: string, degree?: number): boolean {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  const idx = leads.findIndex((l) => l.profileUrn === oldKey || keyOf(l) === oldKey);
  if (idx === -1) return false;
  leads[idx].profileUrn = newProfileUrn;
  if (degree !== undefined) leads[idx].degree = degree;
  leads[idx].resolved = true;
  writeJsonl('people.jsonl', leads);
  return true;
}

/**
 * Applique les scores sémantiques : pour chaque clé (profileUrn), fixe
 * `score = patternScore + bonus`, mémorise `semanticSim` et `patternScore`.
 * Idempotent : le score final est toujours recalculé depuis patternScore, jamais accumulé.
 */
export function setSemanticScores(
  byUrn: Record<string, { score: number; patternScore: number; sim: number }>,
): number {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  let n = 0;
  for (const l of leads) {
    const u = l.profileUrn;
    if (u && byUrn[u]) {
      const r = byUrn[u];
      l.score = r.score;
      l.patternScore = r.patternScore;
      l.semanticSim = r.sim;
      n++;
    }
  }
  if (n) writeJsonl('people.jsonl', leads);
  return n;
}

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
  geo?: string; // filtre sur le libellé/URN géo confirmé (LeadRecord.geo), ex. '103644278' (US)
  segment?: string; // filtre sur l'hypothèse de segment (LeadRecord.segment)
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
  if (opts.geo) leads = leads.filter((l) => l.geo === opts.geo);
  if (opts.segment) leads = leads.filter((l) => l.segment === opts.segment);
  if (opts.group) leads = leads.filter((l) => classify(l.headline) === opts.group);
  leads = leads.filter((l) => classify(l.headline) !== 'concurrent'); // JAMAIS contacter un concurrent (il VEND la même solution)
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

/* ---------- messages (1er contact) ---------- */

/**
 * Leads à qui envoyer un 1er message : ont un URN membre valide, pas déjà messagés.
 * Le canal se décide au moment de l'envoi selon le degré (1er degré -> message normal,
 * sinon -> InMail). Tri : connectés (degree=1) d'abord, puis score décroissant.
 */
export function getMessageable(opts: InvitableOpts = {}): LeadRecord[] {
  const minScore = opts.minScore ?? 0;
  let leads = getLeads().filter(
    (l) =>
      !!l.profileUrn &&
      /ACoAA[A-Za-z0-9_-]+/.test(l.profileUrn) &&
      l.name !== 'LinkedIn Member' &&
      l.messageStatus !== 'sent' &&
      l.score >= minScore,
  );
  if (opts.geo) leads = leads.filter((l) => l.geo === opts.geo);
  if (opts.segment) leads = leads.filter((l) => l.segment === opts.segment);
  if (opts.group) leads = leads.filter((l) => classify(l.headline) === opts.group);
  leads = leads.filter((l) => classify(l.headline) !== 'concurrent'); // JAMAIS contacter un concurrent (il VEND la même solution)
  leads.sort((a, b) => {
    const c = Number(b.degree === 1) - Number(a.degree === 1); // connectés d'abord
    return c !== 0 ? c : b.score - a.score;
  });
  return opts.limit ? leads.slice(0, opts.limit) : leads;
}

/** Leads à RELANCER : déjà messagés (messageStatus=sent), 1er degré, pas encore relancés,
 * et messagedAt antérieur à `before` si fourni (délai de relance). Tri score décroissant. */
export function getFollowupable(opts: InvitableOpts & { before?: string; maxFollowups?: number } = {}): LeadRecord[] {
  const minScore = opts.minScore ?? 0;
  const maxFollowups = opts.maxFollowups ?? 1; // une seule relance par défaut (un seul template)
  let leads = getLeads().filter((l) => {
    if (l.messageStatus !== 'sent' || l.degree !== 1 || l.repliedStatus === 'replied') return false;
    if ((l.score ?? 0) < minScore) return false;
    if ((l.followupCount ?? 0) >= maxFollowups) return false;
    // Écart depuis le DERNIER contact (dernière relance sinon 1er message) : doit précéder `before`.
    const lastContact = l.followupAt || l.messagedAt || '';
    if (opts.before && !(lastContact && lastContact < opts.before)) return false;
    return true;
  });
  if (opts.geo) leads = leads.filter((l) => l.geo === opts.geo);
  if (opts.segment) leads = leads.filter((l) => l.segment === opts.segment);
  if (opts.group) leads = leads.filter((l) => classify(l.headline) === opts.group);
  leads = leads.filter((l) => classify(l.headline) !== 'concurrent'); // JAMAIS contacter un concurrent (il VEND la même solution)
  leads.sort((a, b) => b.score - a.score);
  return opts.limit ? leads.slice(0, opts.limit) : leads;
}

/** Marque un lead comme relancé (follow-up envoyé). Clé = profileUrn ou keyOf. */
export function markFollowedUp(key: string, at: string): boolean {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  const idx = leads.findIndex((l) => keyOf(l) === key || l.profileUrn === key);
  if (idx === -1) return false;
  leads[idx].followupStatus = 'sent';
  leads[idx].followupAt = at;
  leads[idx].followupCount = (leads[idx].followupCount ?? 0) + 1;
  writeJsonl('people.jsonl', leads);
  return true;
}

/** Marque un lead comme messagé. Clé = profileUrn ou keyOf. status='failed' laisse la trace d'un échec. */
export function markMessaged(
  key: string,
  at: string,
  channel: 'message' | 'inmail',
  status: 'sent' | 'failed' = 'sent',
  conversationId?: string,
): boolean {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  const idx = leads.findIndex((l) => keyOf(l) === key || l.profileUrn === key);
  if (idx === -1) return false;
  leads[idx].messageStatus = status;
  leads[idx].messageChannel = channel;
  if (status === 'sent') leads[idx].messagedAt = at;
  if (conversationId) leads[idx].conversationId = conversationId;
  writeJsonl('people.jsonl', leads);
  return true;
}

/** Leads MESSAGÉS dont on n'a pas encore détecté de réponse, et qui ont un conversationId.
 * Rotation par lastReplyCheckAt (moins récemment vérifié d'abord). Pour `check-replies`. */
export function getReplyCheckable(opts: { limit?: number } = {}): LeadRecord[] {
  const leads = getLeads().filter(
    // à vérifier : messagés avec convId, pas encore répondu — OU répondu sans texte capturé (backfill).
    (l) => l.messageStatus === 'sent' && !!l.conversationId && (l.repliedStatus !== 'replied' || !l.repliedText),
  );
  leads.sort((a, b) => (a.lastReplyCheckAt || '').localeCompare(b.lastReplyCheckAt || ''));
  return opts.limit ? leads.slice(0, opts.limit) : leads;
}

/** Marque en lot les leads ayant répondu (par conversationId). Renvoie le nb modifié. */
export function markRepliedMany(conversationIds: string[], at: string, texts: Record<string, string> = {}): number {
  const set = new Set(conversationIds.filter(Boolean));
  if (!set.size) return 0;
  const leads = readJsonl<LeadRecord>('people.jsonl');
  let n = 0;
  let changed = false;
  for (const l of leads) if (l.conversationId && set.has(l.conversationId)) {
    if (l.repliedStatus !== 'replied') { l.repliedStatus = 'replied'; l.repliedAt = at; n++; changed = true; }
    if (texts[l.conversationId] && !l.repliedText) { l.repliedText = texts[l.conversationId]; changed = true; }
  }
  if (changed) writeJsonl('people.jsonl', leads);
  return n;
}

/** Stampe lastReplyCheckAt (par conversationId) pour la rotation du check-replies. */
export function markReplyCheckedMany(conversationIds: string[], at: string): number {
  const set = new Set(conversationIds.filter(Boolean));
  if (!set.size) return 0;
  const leads = readJsonl<LeadRecord>('people.jsonl');
  let n = 0;
  for (const l of leads) if (l.conversationId && set.has(l.conversationId)) { l.lastReplyCheckAt = at; n++; }
  if (n) writeJsonl('people.jsonl', leads);
  return n;
}

/** Backfill du conversationId sur un lead (par profileUrn). Pour rattraper les messages envoyés avant capture. */
export function setConversationId(profileUrn: string, conversationId: string): boolean {
  const leads = readJsonl<LeadRecord>('people.jsonl');
  const idx = leads.findIndex((l) => l.profileUrn === profileUrn);
  if (idx === -1 || leads[idx].conversationId) return false;
  leads[idx].conversationId = conversationId;
  writeJsonl('people.jsonl', leads);
  return true;
}

/** Stampe lastRelCheckAt (par profileUrn) pour la rotation du check-accepted. Renvoie le nb modifié. */
export function markRelCheckedMany(profileUrns: string[], at: string): number {
  const set = new Set(profileUrns.filter(Boolean));
  if (!set.size) return 0;
  const leads = readJsonl<LeadRecord>('people.jsonl');
  let n = 0;
  for (const l of leads) if (l.profileUrn && set.has(l.profileUrn)) { l.lastRelCheckAt = at; n++; }
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

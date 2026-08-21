/**
 * Endpoints Voyager utilisés pour le lead-gen.
 * queryIds repris tels quels de l'app existante (lea-desktop-app) — observés janv. 2026.
 */
import { voyagerGet, voyagerPost, DailyCapReached } from './client.js';
import { parsePostSearch, parsePeopleSearch, parseComments, parseProfileSlug, parseMemberProfileUrn, parseMemberRelationship, parseSelfUrn, RelationshipStatus, Person, PostRecord, CommentRecord } from './parse.js';
import { normalizePostUrnForVoyager, extractLinkedInSlug, normalizeProfileUrnForMention } from './linkedin-urls.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_DIR } from '../config.js';
import { uploadBinaryInPage } from './browser.js';

const BASE = 'https://www.linkedin.com';

const QID_CLUSTERS_CONTENT = 'voyagerSearchDashClusters.ef3d0937fb65bd7812e32e5a85028e79';
const QID_CLUSTERS_PEOPLE = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';
const QID_COMMENTS = 'voyagerSocialDashComments.afec6d88d7810d45548797a8dac4fb87';
const PROFILE_DECORATION_ID = 'com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76';
const INVITE_DECORATION_ID = 'com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2';

export type DateFilter = 'past-24h' | 'past-week' | 'past-month' | null;

export interface PostSearchPage {
  posts: PostRecord[];
  rawFile?: string;
  nextStart: number;
}

/**
 * Recherche de POSTS par mots-clés (resultType CONTENT).
 * count volontairement petit (défaut 5) pour rester discret et paginer gentiment.
 */
export async function searchPosts(
  keyword: string,
  opts: { start?: number; count?: number; dateFilter?: DateFilter } = {},
): Promise<PostSearchPage> {
  const start = opts.start ?? 0;
  const count = opts.count ?? 5;
  const params: string[] = [`(key:resultType,value:List(CONTENT))`, `(key:sortBy,value:List(relevance))`];
  if (opts.dateFilter) params.unshift(`(key:datePosted,value:List(${opts.dateFilter}))`);
  const queryParameters = `List(${params.join(',')})`;
  const kw = encodeURIComponent(keyword);
  const variables = `(start:${start},origin:FACETED_SEARCH,query:(keywords:${kw},flagshipSearchIntent:SEARCH_SRP,queryParameters:${queryParameters},includeFiltersInResponse:false),count:${count})`;
  const referer = `${BASE}/search/results/content/?keywords=${kw}&origin=SWITCH_SEARCH_VERTICAL`;
  const url = `${BASE}/voyager/api/graphql?variables=${variables}&queryId=${QID_CLUSTERS_CONTENT}`;

  const res = await voyagerGet(url, { context: 'posts', kind: 'search', label: `posts_${keyword}_s${start}`, customReferer: referer });
  const posts = parsePostSearch(res.data);
  return { posts, rawFile: res.rawFile, nextStart: start + count };
}

export interface PeopleSearchPage {
  people: Person[];
  rawFile?: string;
  nextStart: number;
}

/**
 * Table de geoUrn LinkedIn stables et bien connus, pour résoudre un nom de lieu
 * sans appel réseau. AUCUN lieu n'est privilégié — l'agent choisit selon l'ICP.
 * Pour un lieu absent : passer directement un geoUrn brut (l'agent peut l'extraire
 * d'une URL de recherche LinkedIn filtrée : `&geoUrn=<id>`).
 */
export const GEO_TABLE: Record<string, string> = {
  'united states': '103644278',
  'usa': '103644278',
  'us': '103644278',
  'canada': '101174742',
  'united kingdom': '101165590',
  'uk': '101165590',
  'ireland': '104738515',
  'germany': '101282230',
  'france': '105015875',
  'spain': '105646813',
  'italy': '103350119',
  'netherlands': '102890719',
  'switzerland': '106693272',
  'sweden': '105117694',
  'india': '102713980',
  'singapore': '102454443',
  'australia': '101452733',
  'brazil': '106057199',
  'israel': '101620260',
  'european union': '91000000',
  'san francisco bay area': '90000084',
  'new york city metropolitan area': '90000070',
  'greater boston': '90000007',
  'greater seattle area': '90000091',
  'greater los angeles area': '90000049',
  'london area': '90009496',
};

/** urn:li:geo des États-Unis — fourni en raccourci, sans privilégier ce pays. */
export const GEO_US = GEO_TABLE['united states'];

/** Résout un nom de lieu en geoUrn. Renvoie l'id brut tel quel s'il en reçoit un. Null si inconnu. */
export function resolveGeo(nameOrUrn: string): { urn: string; label: string } | null {
  const s = nameOrUrn.trim();
  if (/^\d{6,}$/.test(s)) return { urn: s, label: s }; // déjà un geoUrn brut
  const key = s.toLowerCase();
  if (GEO_TABLE[key]) return { urn: GEO_TABLE[key], label: s };
  // match partiel tolérant (ex: "United States of America")
  for (const [k, urn] of Object.entries(GEO_TABLE)) {
    if (key.includes(k) || k.includes(key)) return { urn, label: s };
  }
  return null;
}

/**
 * Recherche de PERSONNES par mots-clés (resultType PEOPLE), avec filtre géo optionnel.
 * Passer geoUrn pour ne récupérer que des profils d'une localisation (géo confirmée).
 * navigationUrl donne l'URL vanity directe (pas de lookup profil).
 */
export async function searchPeople(
  keyword: string,
  opts: { start?: number; count?: number; geoUrn?: string } = {},
): Promise<PeopleSearchPage> {
  const start = opts.start ?? 0;
  const count = opts.count ?? 10;
  const kw = encodeURIComponent(keyword);
  const params = ['(key:resultType,value:List(PEOPLE))'];
  if (opts.geoUrn) params.push(`(key:geoUrn,value:List(${opts.geoUrn}))`);
  const variables = `(start:${start},origin:FACETED_SEARCH,query:(keywords:${kw},flagshipSearchIntent:SEARCH_SRP,queryParameters:List(${params.join(',')}),includeFiltersInResponse:false))`;
  const url = `${BASE}/voyager/api/graphql?variables=${variables}&queryId=${QID_CLUSTERS_PEOPLE}`;
  const referer = `${BASE}/search/results/people/?keywords=${kw}`;
  const res = await voyagerGet(url, { context: 'people', kind: 'search', label: `people_${keyword}_s${start}`, customReferer: referer });
  const people = parsePeopleSearch(res.data);
  return { people, rawFile: res.rawFile, nextStart: start + count };
}

export interface CommentsPage {
  comments: CommentRecord[];
  rawFile?: string;
  nextStart: number;
}

/**
 * Construit l'URN socialDetail attendu par l'API commentaires. LinkedIn attend
 * l'URN `ugcPost` du post (pas `activity`). On accepte donc :
 *  - un socialDetailUrn déjà complet (urn:li:fsd_socialDetail:(...)) -> tel quel
 *  - un urn ugcPost/share/activity -> on l'enveloppe
 *  - un ID brut -> on suppose activity
 * Le bon usage côté CLI passe le `socialDetailUrn` capturé à la recherche.
 */
function toSocialDetailRaw(input: string): string {
  if (input.includes('fsd_socialDetail')) return input;
  const inner = input.match(/urn:li:(?:ugcPost|share|activity):\d+/)?.[0] || normalizePostUrnForVoyager(input);
  return `urn:li:fsd_socialDetail:(${inner},${inner},urn:li:highlightedReply:-)`;
}

/** Commentaires d'un post. Idéalement on passe le socialDetailUrn (ou ugcPost) capturé à la recherche. */
export async function getComments(
  postUrnOrId: string,
  opts: { start?: number; count?: number; postUrnLabel?: string } = {},
): Promise<CommentsPage> {
  const start = opts.start ?? 0;
  const count = opts.count ?? 10;
  const socialDetailRaw = toSocialDetailRaw(postUrnOrId);
  const postUrn = opts.postUrnLabel || postUrnOrId;
  // Encodage aligné sur le HAR : parenthèses encodées en %28/%29.
  const socialDetailEnc = encodeURIComponent(socialDetailRaw).replace(/\(/g, '%28').replace(/\)/g, '%29');
  const variables = `(count:${count},numReplies:1,socialDetailUrn:${socialDetailEnc},sortOrder:RELEVANCE,start:${start})`;
  const url = `${BASE}/voyager/api/graphql?includeWebMetadata=true&variables=${variables}&queryId=${QID_COMMENTS}`;
  const res = await voyagerGet(url, { context: 'post_comments', kind: 'comments', label: `comments_${postUrn}_s${start}` });
  const comments = parseComments(res.data, postUrn);
  return { comments, rawFile: res.rawFile, nextStart: start + count };
}

/**
 * Résout une URL temporaire/hashée (urn:li:fsd_profile:ACoAA...) en URL vanity réelle
 * (linkedin.com/in/slug). Endpoint profil = TRÈS surveillé : usage parcimonieux,
 * rate-limité séparément (kind=profile, cap 50/jour) et uniquement pour les leads retenus.
 */
export async function resolveProfileUrl(urnOrId: string): Promise<{ profileUrl?: string; publicIdentifier?: string; rawFile?: string }> {
  // Si on a déjà un slug, rien à résoudre.
  const slug = extractLinkedInSlug(urnOrId);
  if (slug && !slug.startsWith('ACoAA') && !slug.includes('urn:') && !/^[A-Z]/.test(slug)) {
    // déjà un public identifier lisible
  }
  let urn = urnOrId;
  if (!urn.startsWith('urn:')) {
    const m = urn.match(/(ACoAA[A-Za-z0-9_-]+)/);
    urn = `urn:li:fsd_profile:${m ? m[1] : urn}`;
  }
  const url = `${BASE}/voyager/api/identity/dash/profiles/${urn}?decorationId=${encodeURIComponent(PROFILE_DECORATION_ID)}`;
  const res = await voyagerGet(url, { context: 'profile', kind: 'profile', label: `profile_${urn.split(':').pop()}` });
  const parsed = parseProfileSlug(res.data);
  return { ...parsed, rawFile: res.rawFile };
}

/**
 * Résout un identifiant public / vanity (ou URL linkedin.com/in/slug) vers l'URN
 * fsd_profile invitable (ACoAA...), via le lookup profil q=memberIdentity.
 * Sert à rendre invitables les commentateurs récoltés (qui arrivent en
 * urn:li:member:NNNN, refusé par l'API invite). Endpoint profil TRÈS surveillé :
 * kind='profile' -> compte dans le bucket profile (cap 50/jour, espacé).
 */
export async function resolveMemberProfileUrn(vanityOrUrl: string): Promise<{ profileUrn?: string; publicIdentifier?: string; rawFile?: string }> {
  const slug = extractLinkedInSlug(vanityOrUrl);
  if (!slug || slug.startsWith('ACoAA') || slug.includes('urn:') || /^\d+$/.test(slug)) return {};
  const url = `${BASE}/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}&decorationId=${encodeURIComponent(PROFILE_DECORATION_ID)}`;
  const res = await voyagerGet(url, { context: 'profile', kind: 'profile', label: `member_${slug}` });
  const parsed = parseMemberProfileUrn(res.data, slug);
  const profileUrn = parsed.profileUrn ? (parsed.profileUrn.startsWith('urn:') ? parsed.profileUrn : `urn:li:fsd_profile:${parsed.profileUrn}`) : undefined;
  return { profileUrn, publicIdentifier: parsed.publicIdentifier, rawFile: res.rawFile };
}

export interface MemberRelationship {
  status: RelationshipStatus;
  distance?: number; // 1/2/3, 0 = hors réseau
  rawFile?: string;
}

/**
 * État de la relation avec un membre, via l'entité memberRelationship (dash).
 * FIABLE et par URN (indépendant du nom, contrairement à une recherche) :
 *   'connected' = a accepté (1er degré) · 'pending' = invitation en attente ·
 *   'none' = aucune relation/invitation active. kind='connections' (cap dédié).
 */
export async function getMemberRelationship(profileUrnOrId: string): Promise<MemberRelationship> {
  const id = profileUrnOrId.match(/ACoAA[A-Za-z0-9_-]+/)?.[0] || profileUrnOrId.split(':').pop() || profileUrnOrId;
  const relUrn = `urn:li:fsd_memberRelationship:${id}`;
  const url = `${BASE}/voyager/api/voyagerRelationshipsDashMemberRelationships/${encodeURIComponent(relUrn)}`;
  const res = await voyagerGet(url, { context: 'connections', kind: 'connections', label: `rel_${id}` });
  return { ...parseMemberRelationship(res.data), rawFile: res.rawFile };
}

/* ==================== Réseau : invitations ==================== */

export interface InviteResult {
  ok: boolean;
  status: number;
  rawFile?: string;
  error?: string;
}

/**
 * Envoie une demande de connexion (invitation) via l'API Voyager (même endpoint
 * que le bouton "Se connecter" du site). Sans note par défaut. Nécessite l'URN
 * fsd_profile du destinataire. kind='invite' -> espacement 60-120s + plafond
 * quotidien (défaut 20/j) appliqués par l'outil.
 *
 * Relance DailyCapReached (pour que la boucle appelante s'arrête proprement) ;
 * toute autre erreur est renvoyée dans le résultat (ok:false) pour ne pas
 * interrompre le lot sur un seul profil (ex: déjà invité, hors réseau).
 */
export async function sendInvitation(profileUrnOrId: string, opts: { message?: string } = {}): Promise<InviteResult> {
  const urn = normalizeProfileUrnForMention(profileUrnOrId); // -> urn:li:fsd_profile:ID
  const url =
    `${BASE}/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2` +
    `&decorationId=${INVITE_DECORATION_ID}`;
  // Forme EXACTE observée dans un HAR du bouton "Se connecter" (réponse 200 -> invitationUrn).
  const payload: Record<string, unknown> = { invitee: { inviteeUnion: { memberProfile: urn } } };
  if (opts.message && opts.message.trim()) payload.customMessage = opts.message.trim();
  try {
    const res = await voyagerPost(url, { context: 'invite', kind: 'invite', label: `invite_${urn.split(':').pop()}`, body: payload });
    return { ok: true, status: res.status, rawFile: res.rawFile };
  } catch (e: any) {
    if (e instanceof DailyCapReached) throw e;
    return { ok: false, status: e?.status ?? 0, error: e?.message || String(e) };
  }
}

/* ==================== Messagerie (1er contact) ==================== */
/*
 * ⚠️ UNVERIFIED : endpoint + payload dérivés du flux web "createMessage", PAS encore
 * confirmés par un HAR d'envoi réel (contrairement à sendInvitation, verrouillé via HAR).
 * À confirmer avec un HAR d'un message normal ET d'un InMail avant de faire confiance.
 */

export interface SendMessageResult {
  ok: boolean;
  status: number;
  channel: 'message' | 'inmail';
  conversationId?: string; // id de thread (2-…) extrait de la réponse, pour la détection de réponse ultérieure
  noInmailCredit?: boolean; // le serveur signale : plus de crédit InMail -> inutile d'insister aujourd'hui
  notAllowed?: boolean; // destinataire non joignable (ni relation, ni Open Profile, ni crédit)
  rawFile?: string;
  error?: string;
}

let _selfUrn: string | null = null;
const SELF_PATH = resolve(STATE_DIR, 'self.json');
/** URN fsd_profile du compte courant (mailboxUrn). Cache mémoire + disque (state/self.json)
 * pour éviter un appel /me par process. /me sur le bucket voyager (large), pas connections. */
export async function getSelfUrn(): Promise<string> {
  if (_selfUrn) return _selfUrn;
  try {
    if (existsSync(SELF_PATH)) {
      const u = JSON.parse(readFileSync(SELF_PATH, 'utf8'))?.urn;
      if (typeof u === 'string' && u) return (_selfUrn = u);
    }
  } catch { /* cache illisible -> refetch */ }
  const res = await voyagerGet(`${BASE}/voyager/api/me`, { context: 'profile', kind: 'search', label: 'me' });
  const urn = parseSelfUrn(res.data);
  if (!urn) throw new Error("Impossible de déterminer l'URN du compte courant (/me).");
  _selfUrn = urn;
  try { writeFileSync(SELF_PATH, JSON.stringify({ urn })); } catch { /* cache best-effort */ }
  return urn;
}

/** Extrait l'id de thread (2-…) de la réponse createMessage (via l'URN msg_conversation). */
function parseConversationId(resp: any): string | undefined {
  const m = JSON.stringify(resp ?? '').match(/urn:li:msg_conversation:\(urn:li:fsd_profile:[^,]+,(2-[A-Za-z0-9+/=_-]+)\)/);
  return m?.[1];
}

/**
 * Détecte une RÉPONSE dans une conversation : lit les events du thread et repère
 * un message dont l'expéditeur n'est pas soi. Endpoint CONFIRMÉ live (200) :
 * GET /voyager/api/messaging/conversations/{convId}/events. kind='connections'.
 */
export async function conversationHasReply(conversationId: string): Promise<{ replied: boolean; incoming: number; text?: string; rawFile?: string }> {
  const self = (await getSelfUrn()).match(/ACoAA[A-Za-z0-9_-]+/)?.[0] || '__none__';
  const url = `${BASE}/voyager/api/messaging/conversations/${encodeURIComponent(conversationId)}/events?count=20`;
  const res = await voyagerGet(url, { context: 'messaging', kind: 'connections', label: `conv_${conversationId.slice(0, 12)}` });
  const els: any[] = res.data?.elements || res.data?.data?.elements || [];
  let incoming = 0;
  const texts: string[] = [];
  for (const e of els) {
    const id = JSON.stringify(e?.from ?? {}).match(/ACoAA[A-Za-z0-9_-]+/)?.[0];
    if (id && id !== self) {
      incoming++;
      const m = [...JSON.stringify(e).matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
      const t = m.sort((a, b) => b.length - a.length)[0];
      if (t) texts.push(t.replace(/\\n/g, ' ').replace(/\\"/g, '"'));
    }
  }
  return { replied: incoming > 0, incoming, text: texts.join('  |  ').slice(0, 500) || undefined, rawFile: res.rawFile };
}

/**
 * URN fsd_profile (ACoAA...) de l'AUTRE participant de chaque conversation
 * RÉCENTE de la boîte. Sert de garde-fou : ne PAS écrire un 1er message à froid
 * à quelqu'un avec qui un fil existe déjà (conversation organique / historique).
 * L'inbox ne rend que les ~20 fils les plus récents (pagination non fiable), ce
 * qui couvre les conversations ACTIVES — le cas à risque. kind='connections'.
 */
export async function getRecentConversationParticipants(): Promise<Set<string>> {
  const self = await getSelfUrn();
  const selfId = self.match(/ACoAA[A-Za-z0-9_-]+/)?.[0];
  const url =
    `${BASE}/voyager/api/voyagerMessagingGraphQL/graphql` +
    `?queryId=messengerConversations.0d5e6781bbee71c3e51c8843c6519f48` +
    `&variables=(mailboxUrn:${encodeURIComponent(self)})`;
  const res = await voyagerGet(url, { context: 'messaging', kind: 'search', label: 'inbox' });
  const ids = new Set<string>();
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.entityUrn && String(n.entityUrn).includes('msg_conversation') && n.conversationParticipants) {
      for (const id of JSON.stringify(n.conversationParticipants).match(/ACoAA[A-Za-z0-9_-]+/g) || []) {
        if (id && id !== selfId) ids.add(id);
      }
    }
    Object.values(n).forEach(walk);
  };
  walk(res.data);
  return ids;
}

/**
 * Le PREMIER message (le plus ancien) du fil a-t-il été envoyé par NOUS ?
 * Règle de relance : on ne relance QUE les fils qu'on a initiés (sinon on
 * s'incruste dans une conversation organique). Renvoie false si indéterminable
 * (prudence). kind='connections'.
 */
export async function conversationFirstFromSelf(conversationId: string): Promise<boolean> {
  const self = (await getSelfUrn()).match(/ACoAA[A-Za-z0-9_-]+/)?.[0] || '__none__';
  const url = `${BASE}/voyager/api/messaging/conversations/${encodeURIComponent(conversationId)}/events?count=20`;
  const res = await voyagerGet(url, { context: 'messaging', kind: 'search', label: `first_${conversationId.slice(0, 12)}` });
  const els: any[] = res.data?.elements || res.data?.data?.elements || [];
  const ordered = els
    .map((e) => ({ t: Number(e?.createdAt ?? 0), from: JSON.stringify(e?.from ?? {}).match(/ACoAA[A-Za-z0-9_-]+/)?.[0] }))
    .filter((e) => e.from)
    .sort((a, b) => a.t - b.t);
  if (!ordered.length) return false;
  return ordered[0].from === self;
}

function randomTrackingId(): string {
  // Chaîne binaire de 16 octets, telle quelle (format exact observé dans le HAR : PAS de base64).
  let s = '';
  for (let i = 0; i < 16; i++) s += String.fromCharCode(Math.floor(Math.random() * 256));
  return s;
}

/**
 * Upload une image comme pièce jointe messagerie. Flux CONFIRMÉ via HAR (image_send.har) :
 * 1) POST voyagerVideoDashMediaUploadMetadata?action=upload -> singleUploadUrl + assetUrn ;
 * 2) PUT des octets (image/jpeg, header media-type-family: STILLIMAGE) sur singleUploadUrl (201).
 * L'assetUrn est ensuite référencé dans message.renderContentUnions[].file.
 */
export async function uploadMessagingImage(filePath: string): Promise<{ assetUrn: string; byteSize: number; mediaType: string; name: string }> {
  const buf = readFileSync(filePath);
  const name = filePath.split('/').pop() || 'image.jpg';
  const mediaType = /\.png$/i.test(name) ? 'image/png' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg';
  const metaRes = await voyagerPost(`${BASE}/voyager/api/voyagerVideoDashMediaUploadMetadata?action=upload`, {
    context: 'people',
    kind: 'search', // bucket voyager (large) : l'upload est borné par le vrai plafond du message
    label: 'mediaMeta',
    body: { fileSize: buf.length, filename: name, mediaUploadType: 'MESSAGING_PHOTO_ATTACHMENT' },
  });
  const val = metaRes.data?.data?.value ?? metaRes.data?.value;
  const uploadUrl: string | undefined = val?.singleUploadUrl;
  const assetUrn: string | undefined = val?.urn;
  if (!uploadUrl || !assetUrn) throw new Error('mediaUploadMetadata: singleUploadUrl/urn manquants');
  const put = await uploadBinaryInPage(uploadUrl, buf.toString('base64'), mediaType);
  if (put.status !== 201 && put.status !== 200) throw new Error(`upload PUT HTTP ${put.status}`);
  return { assetUrn, byteSize: buf.length, mediaType, name };
}

/**
 * Envoie un 1er message. channel='message' = message normal (destinataire en 1er degré) ;
 * channel='inmail' = InMail (non connecté). Nécessite l'URN fsd_profile du destinataire.
 * kind='message' -> espacement 45-90s + plafond quotidien appliqués par l'outil.
 * Relance DailyCapReached ; sinon renvoie ok:false (avec noInmailCredit/notAllowed si détecté),
 * pour que la boucle appelante gère "plus de crédit" sans planter sur un seul profil.
 */
export async function sendMessage(
  recipientUrnOrId: string,
  text: string,
  opts: { channel?: 'message' | 'inmail'; subject?: string; conversationId?: string; imagePath?: string } = {},
): Promise<SendMessageResult> {
  const channel = opts.channel ?? 'message';
  const recipient = normalizeProfileUrnForMention(recipientUrnOrId); // -> urn:li:fsd_profile:ID
  let mailbox: string;
  try {
    mailbox = await getSelfUrn();
  } catch (e: any) {
    if (e instanceof DailyCapReached) throw e;
    return { ok: false, status: e?.status ?? 0, channel, error: e?.message || String(e) };
  }
  const url = `${BASE}/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage`;
  // Forme confirmée via HAR : renderContentUnions + originToken ; conversationUrn pour une
  // conversation EXISTANTE (relance), hostRecipientUrns pour un 1er contact ; mailboxUrn = expéditeur.
  let renderContentUnions: unknown[] = [];
  if (opts.imagePath) {
    try {
      const media = await uploadMessagingImage(opts.imagePath);
      renderContentUnions = [{ file: { assetUrn: media.assetUrn, byteSize: media.byteSize, mediaType: media.mediaType, name: media.name } }];
    } catch (e: any) {
      if (e instanceof DailyCapReached) throw e;
      return { ok: false, status: e?.status ?? 0, channel, error: `upload image: ${e?.message || String(e)}` };
    }
  }
  const message: Record<string, unknown> = { body: { attributes: [], text }, renderContentUnions, originToken: randomUUID() };
  if (channel === 'inmail' && opts.subject?.trim()) message.subject = opts.subject.trim();
  if (opts.conversationId) message.conversationUrn = `urn:li:msg_conversation:(${mailbox},${opts.conversationId})`;
  const payload: Record<string, unknown> = {
    message,
    mailboxUrn: mailbox,
    trackingId: randomTrackingId(),
    dedupeByClientGeneratedToken: false,
  };
  if (!opts.conversationId) payload.hostRecipientUrns = [recipient];
  try {
    const res = await voyagerPost(url, { context: 'messaging', kind: 'message', label: `msg_${recipient.split(':').pop()}`, body: payload });
    return { ok: true, status: res.status, channel, conversationId: parseConversationId(res.data), rawFile: res.rawFile };
  } catch (e: any) {
    if (e instanceof DailyCapReached) throw e;
    const status: number = e?.status ?? 0;
    const body = String(e?.message || '');
    const noInmailCredit =
      channel === 'inmail' &&
      (status === 422 || (/inmail/i.test(body) && /(credit|quota|limit|balance|insufficient|no longer)/i.test(body)));
    const notAllowed = status === 403 || /not.?allowed|cannot (be )?messag|recipient.*(invalid|not)/i.test(body);
    return { ok: false, status, channel, noInmailCredit: noInmailCredit || undefined, notAllowed: notAllowed || undefined, error: body };
  }
}

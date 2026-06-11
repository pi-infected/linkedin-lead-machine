/**
 * Endpoints Voyager utilisés pour le lead-gen.
 * queryIds repris tels quels de l'app existante (lea-desktop-app) — observés janv. 2026.
 */
import { voyagerGet } from './client.js';
import { parsePostSearch, parsePeopleSearch, parseComments, parseProfileSlug, Person, PostRecord, CommentRecord } from './parse.js';
import { normalizePostUrnForVoyager, extractLinkedInSlug } from './linkedin-urls.js';

const BASE = 'https://www.linkedin.com';

const QID_CLUSTERS_CONTENT = 'voyagerSearchDashClusters.ef3d0937fb65bd7812e32e5a85028e79';
const QID_CLUSTERS_PEOPLE = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';
const QID_COMMENTS = 'voyagerSocialDashComments.afec6d88d7810d45548797a8dac4fb87';
const PROFILE_DECORATION_ID = 'com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76';

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

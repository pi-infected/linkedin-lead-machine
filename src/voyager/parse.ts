/**
 * Parsers DÉFENSIFS des réponses Voyager (JSON "normalized" : un arbre `data` +
 * un tableau `included[]` d'entités référencées par entityUrn).
 *
 * LinkedIn change souvent ses schémas, donc plutôt que de coder en dur un chemin
 * fragile, on scanne récursivement la réponse pour repérer :
 *   - les nœuds "personne"  (nom + headline + éventuellement URL vanity + URN profil)
 *   - les nœuds "post"       (texte + auteur + compteurs d'engagement)
 *   - les nœuds "commentaire" (texte + commentateur)
 *
 * La réponse brute est de toute façon sauvée sur disque (client.ts) : si un champ
 * manque, on peut affiner ces heuristiques sans relancer d'appel réseau.
 */
import { extractLinkedInSlug, normalizeLinkedInProfileUrl } from './linkedin-urls.js';

export interface Person {
  name: string;
  headline?: string; // = tagline
  profileUrl?: string; // vraie URL vanity si dispo (sinon à résoudre via profile)
  profileUrn?: string; // urn:li:fsd_profile:ACoAA... (URL temporaire/hashée)
  source: 'post_author' | 'commenter' | 'people_search';
  degree?: number; // 1=1er degré (déjà connecté), 2/3=2e/3e, 0=hors réseau, undefined=inconnu
}

export interface PostRecord {
  postUrn?: string; // urn:li:activity:... (affiché)
  ugcPostUrn?: string; // urn:li:ugcPost:... (sert à charger les commentaires)
  socialDetailUrn?: string; // urn:li:fsd_socialDetail:(...) brut, depuis *socialDetail
  text: string;
  author: Person;
  reactions?: number;
  comments?: number;
  reposts?: number;
  createdHint?: string; // texte type "2d", "1w" si présent
}

export interface CommentRecord {
  postUrn: string;
  text: string;
  author: Person;
  likes?: number;
}

/* ---------- helpers ---------- */

function asText(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'object') {
    return (
      asText(v.text) ??
      asText(v.attributedText?.text) ??
      asText(v.accessibilityText) ??
      undefined
    );
  }
  return undefined;
}

function urlFromNav(node: any): string | undefined {
  const candidates = [
    node?.navigationUrl,
    node?.navigationContext?.actionTarget,
    node?.navigationContext?.url,
    node?.actorNavigationUrl,
  ].filter(Boolean) as string[];
  for (const raw of candidates) {
    const clean = String(raw).split('?')[0];
    if (clean.includes('/in/') || clean.includes('/company/')) {
      const n = normalizeLinkedInProfileUrl(clean.startsWith('http') ? clean : `https://www.linkedin.com${clean}`);
      if (n) return n;
    }
  }
  return undefined;
}

function profileUrnFrom(node: any): string | undefined {
  const cands = [
    node?.entityUrn,
    node?.trackingUrn,
    node?.actor?.profileUrn,
    node?.actorUnion?.profileUrn,
    node?.urn,
  ].filter((x) => typeof x === 'string') as string[];
  for (const u of cands) {
    if (u.includes('fsd_profile') || u.includes(':member:') || /ACoAA/i.test(u)) {
      const m = u.match(/(ACoAA[A-Za-z0-9_-]+)/);
      if (m) return `urn:li:fsd_profile:${m[1]}`;
      if (u.startsWith('urn:')) return u;
    }
  }
  return undefined;
}

/** Degré de connexion depuis le nœud résultat (entityCustomTrackingInfo.memberDistance). */
function degreeFrom(node: any): number | undefined {
  const md = node?.entityCustomTrackingInfo?.memberDistance ?? node?.memberDistance;
  switch (md) {
    case 'DISTANCE_1': return 1;
    case 'DISTANCE_2': return 2;
    case 'DISTANCE_3': return 3;
    case 'OUT_OF_NETWORK': return 0;
    default: return undefined;
  }
}

/** Un nœud ressemble-t-il à une "personne" affichée (search/commenter) ? */
function personFrom(node: any, source: Person['source']): Person | null {
  if (!node || typeof node !== 'object') return null;
  const name =
    asText(node.title) ??
    asText(node.name) ??
    ([node.firstName, node.lastName].filter(Boolean).join(' ').trim() || undefined);
  const headline =
    asText(node.primarySubtitle) ??
    asText(node.subtitle) ??
    asText(node.headline) ??
    asText(node.description) ??
    asText(node.occupation);
  const profileUrl = urlFromNav(node);
  const profileUrn = profileUrnFrom(node);
  if (!name && !profileUrl && !profileUrn) return null;
  // Filtrer le bruit : il faut au moins un nom OU une URL/urn de profil exploitable
  if (!name) return null;
  return {
    name,
    headline,
    profileUrl,
    profileUrn,
    source,
    degree: degreeFrom(node),
  };
}

function deepWalk(root: any, visit: (node: any) => void): void {
  const seen = new Set<any>();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (seen.has(n)) continue;
    seen.add(n);
    visit(n);
    if (Array.isArray(n)) {
      for (const c of n) stack.push(c);
    } else {
      for (const k of Object.keys(n)) stack.push(n[k]);
    }
  }
}

function getIncluded(data: any): any[] {
  return data?.included ?? data?.data?.included ?? [];
}

function dedupePeople(people: Person[]): Person[] {
  const map = new Map<string, Person>();
  for (const p of people) {
    const key = p.profileUrn || p.profileUrl || p.name.toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, p);
    } else {
      // fusion : on garde le plus d'infos
      map.set(key, {
        ...prev,
        headline: prev.headline || p.headline,
        profileUrl: prev.profileUrl || p.profileUrl,
        profileUrn: prev.profileUrn || p.profileUrn,
      });
    }
  }
  return [...map.values()];
}

/* ---------- parsers publics ---------- */

/** Personnes issues d'une recherche PEOPLE. */
export function parsePeopleSearch(resp: any): Person[] {
  const included = getIncluded(resp);
  const out: Person[] = [];
  for (const node of included) {
    // EntityResultViewModel : title + primarySubtitle + navigationUrl
    if (node && (node.navigationUrl || node.primarySubtitle || node.title)) {
      const p = personFrom(node, 'people_search');
      if (p) out.push(p);
    }
  }
  return dedupePeople(out);
}

/** Posts (recherche CONTENT) : texte + auteur + compteurs. */
export function parsePostSearch(resp: any): PostRecord[] {
  const included = getIncluded(resp);
  const out: PostRecord[] = [];

  for (const node of included) {
    if (!node || typeof node !== 'object') continue;
    const commentary = asText(node.commentary);
    // un "update" a typiquement commentary + actor
    if (!commentary) continue;
    const actor = node.actor ?? node.actorUnion ?? {};
    const author =
      personFrom(actor, 'post_author') ||
      personFrom({ title: actor?.name, subtitle: actor?.description, navigationContext: actor?.navigationContext, urn: actor?.urn }, 'post_author');
    const postUrn =
      (typeof node.entityUrn === 'string' && node.entityUrn.match(/urn:li:(activity|ugcPost|share):\d+/)?.[0]) ||
      (typeof node.updateMetadata?.urn === 'string' ? node.updateMetadata.urn : undefined) ||
      (typeof node.dashEntityUrn === 'string' ? node.dashEntityUrn : undefined);

    const counts = countsForPost(node, included);
    const sd: unknown = node['*socialDetail'];
    const socialDetailUrn = typeof sd === 'string' ? sd : undefined;
    const ugcPostUrn = socialDetailUrn?.match(/urn:li:(?:ugcPost|share):\d+/)?.[0];
    out.push({
      postUrn,
      ugcPostUrn,
      socialDetailUrn,
      text: commentary,
      author: author || { name: 'unknown', source: 'post_author' },
      reactions: counts?.reactions,
      comments: counts?.comments,
      reposts: counts?.reposts,
      createdHint: asText(node.actor?.subDescription) ?? undefined,
    });
  }
  return out;
}

/** Commentaires d'un post : texte + commentateur. */
export function parseComments(resp: any, postUrn: string): CommentRecord[] {
  const included = getIncluded(resp);
  const out: CommentRecord[] = [];
  for (const node of included) {
    if (!node || typeof node !== 'object') continue;
    const commentary = asText(node.commentary) ?? asText(node.comment);
    const commenter = node.commenter ?? node.commenterForDashConversion ?? node['*commenter'];
    if (!commentary || !commenter) continue;
    let author: Person | null = null;
    if (typeof commenter === 'object') {
      author = personFrom(commenter, 'commenter');
    } else if (typeof commenter === 'string' && commenter.startsWith('urn:')) {
      const ref = included.find((i: any) => i?.entityUrn === commenter);
      author = ref ? personFrom(ref, 'commenter') : { name: 'unknown', profileUrn: commenter, source: 'commenter' };
    }
    out.push({
      postUrn,
      text: commentary,
      author: author || { name: 'unknown', source: 'commenter' },
      likes: numFrom(node, ['reactionsCount', 'likesCount', 'totalReactions']),
    });
  }
  return out;
}

/** Extrait le publicIdentifier (slug) d'une réponse profil pour reconstruire l'URL réelle. */
export function parseProfileSlug(resp: any): { publicIdentifier?: string; profileUrl?: string } {
  let publicIdentifier: string | undefined;
  deepWalk(resp, (n) => {
    if (!publicIdentifier && n && typeof n.publicIdentifier === 'string' && n.publicIdentifier.length > 0) {
      publicIdentifier = n.publicIdentifier;
    }
  });
  if (!publicIdentifier) return {};
  return {
    publicIdentifier,
    profileUrl: normalizeLinkedInProfileUrl(`https://www.linkedin.com/in/${publicIdentifier}/`),
  };
}

/* ---------- counts ---------- */

function numFrom(node: any, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = node?.[k];
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && typeof v.value === 'number') return v.value;
  }
  return undefined;
}

/**
 * Lie un post à SES compteurs. L'Update porte `*socialDetail` =
 * urn:li:fsd_socialDetail:(URN_POST,...) ; les SocialActivityCounts sont indexés
 * par urn:li:fsd_socialActivityCounts:URN_POST. On matche par cet URN exact
 * (sinon on prendrait les compteurs du mauvais post).
 */
function countsForPost(node: any, included: any[]): { reactions?: number; comments?: number; reposts?: number } | null {
  const sd: unknown = node['*socialDetail'] ?? node.socialDetail?.['*entityUrn'] ?? node.socialDetail?.entityUrn;
  let targetUrn: string | undefined;
  if (typeof sd === 'string') {
    const m = sd.match(/fsd_socialDetail:\(([^,]+),/);
    if (m) targetUrn = m[1];
  }
  if (targetUrn) {
    const countsUrn = `urn:li:fsd_socialActivityCounts:${targetUrn}`;
    const c = included.find((i: any) => i?.entityUrn === countsUrn);
    if (c) {
      return {
        reactions: typeof c.numLikes === 'number' ? c.numLikes : undefined,
        comments: typeof c.numComments === 'number' ? c.numComments : undefined,
        reposts: typeof c.numShares === 'number' ? c.numShares : undefined,
      };
    }
  }
  // Fallback prudent : compteurs trouvés DANS le nœud lui-même (jamais un autre post).
  let local: any = null;
  deepWalk(node, (n) => {
    if (local) return;
    if (n && (typeof n.numLikes === 'number' || typeof n.numComments === 'number')) local = n;
  });
  if (!local) return null;
  return {
    reactions: typeof local.numLikes === 'number' ? local.numLikes : undefined,
    comments: typeof local.numComments === 'number' ? local.numComments : undefined,
    reposts: typeof local.numShares === 'number' ? local.numShares : undefined,
  };
}

export { extractLinkedInSlug };

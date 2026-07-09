/**
 * LinkedIn URL utilities shared across the extension.
 * Ported from electron/services/utils.ts.
 */

/**
 * Validates that a LinkedIn post URN has the correct format.
 * Valid URNs: urn:li:activity:... or urn:li:ugcPost:...
 * Invalid URNs: urn:li:member:..., urn:li:company:..., etc.
 */
export function isValidPostUrn(postUrn: string | null | undefined): boolean {
  if (!postUrn || typeof postUrn !== 'string') {
    return false;
  }

  const trimmed = postUrn.trim();

  // Valid URNs: urn:li:activity:... or urn:li:ugcPost:...
  const validPattern = /^urn:li:(activity|ugcPost):\d+$/;

  if (validPattern.test(trimmed)) {
    return true;
  }

  // Detect common invalid URNs (member, company, etc.)
  const invalidPattern = /^urn:li:(member|company|organization|profile|fsd_profile|fsd_update):/;
  if (invalidPattern.test(trimmed)) {
    return false;
  }

  // If it starts with urn:li: but doesn't match any known pattern, consider invalid
  if (trimmed.startsWith('urn:li:')) {
    return false;
  }

  // If it's not a URN at all, consider invalid
  return false;
}

/**
 * Normalizes a person's name for comparison.
 * Lowercases, trims, and collapses whitespace.
 */
export function normalizePersonName(name: string): string {
  if (!name || name.trim() === '') return '';

  try {
    let normalized = name.trim().toLowerCase();
    normalized = normalized.replace(/\s+/g, ' ');
    return normalized;
  } catch {
    return name.trim().toLowerCase();
  }
}

/**
 * Normalizes a LinkedIn profile URL to a canonical form.
 * Handles personal (/in/) and company (/company/) profiles.
 * Returns empty string for invalid or non-profile URLs.
 */
export function normalizeLinkedInProfileUrl(url: string): string {
  if (!url || url.trim() === '') return '';

  try {
    let normalized = url.trim();

    try {
      if (normalized.includes('%')) {
        normalized = decodeURIComponent(normalized);
      }
    } catch {
      console.warn(`[Utils] Could not decode URL, using original: ${url}`);
    }

    normalized = normalized.toLowerCase();

    // Reject post URLs (not profile URLs)
    if (normalized.includes('/feed/update/') ||
        normalized.includes('/posts/') ||
        normalized.includes('urn:li:activity') ||
        normalized.includes('urn:li:share') ||
        normalized.includes('urn%3ali%3aactivity') ||
        normalized.includes('urn%3ali%3ashare')) {
      console.warn(`[Utils] Not a profile URL (post URL detected): ${url}`);
      return '';
    }

    // Force https
    normalized = normalized.replace(/^http:/, 'https:');

    // Remove subdomains (www., fr., uk., etc.)
    normalized = normalized.replace(/https:\/\/([a-z]{2,3}\.)?linkedin\.com/, 'https://linkedin.com');

    // Remove tracking params and anchors
    normalized = normalized.split('?')[0];
    normalized = normalized.split('#')[0];

    // Extract only the slug part (/in/, /company/, /school/)
    const matchIn = normalized.match(/^(https:\/\/linkedin\.com\/in\/[^/]+)/);
    const matchCompany = normalized.match(/^(https:\/\/linkedin\.com\/company\/[^/]+)/);
    const matchSchool = normalized.match(/^(https:\/\/linkedin\.com\/school\/[^/]+)/);

    if (matchIn) {
      normalized = matchIn[1];
    } else if (matchCompany) {
      normalized = matchCompany[1];
    } else if (matchSchool) {
      normalized = matchSchool[1];
    } else {
      console.warn(`[Utils] Unrecognized LinkedIn URL: ${url}`);
      return '';
    }

    // Add trailing slash
    if (!normalized.endsWith('/')) {
      normalized += '/';
    }

    return normalized;
  } catch (error) {
    console.error('[Utils] URL normalization error:', error);
    const fallback = url.toLowerCase();
    return fallback.endsWith('/') ? fallback : fallback + '/';
  }
}

/**
 * Normalise un URN / id de post pour les appels Voyager (NormComments, socialDetail, like…).
 * Important : `urn:li:ugcPost:ID` et `urn:li:activity:ID` ne sont pas interchangeables — ne pas
 * réutiliser l’id d’un ugcPost comme activity (sinon 400 ou comportement incohérent).
 * Accepte activity, ugcPost, share (→ activity), id numérique seul (→ activity), ou URL contenant un URN.
 */
export function normalizePostUrnForVoyager(postUrnOrId: string | null | undefined): string {
  if (!postUrnOrId || typeof postUrnOrId !== 'string') {
    throw new Error('Identifiant de post vide ou invalide');
  }
  const trimmed = postUrnOrId.trim();
  if (/^\d+$/.test(trimmed)) {
    return `urn:li:activity:${trimmed}`;
  }
  const activityMatch = trimmed.match(/^urn:li:activity:(\d+)$/);
  if (activityMatch) {
    return trimmed;
  }
  const ugcMatch = trimmed.match(/^urn:li:ugcPost:(\d+)$/);
  if (ugcMatch) {
    return trimmed;
  }
  const shareMatch = trimmed.match(/^urn:li:share:(\d+)$/);
  if (shareMatch) {
    return `urn:li:activity:${shareMatch[1]}`;
  }
  // URL ou texte contenant un URN : tester ugcPost avant activity (ids distincts).
  const urlUgcMatch = trimmed.match(/urn:li:ugcPost:(\d+)/);
  if (urlUgcMatch) {
    return `urn:li:ugcPost:${urlUgcMatch[1]}`;
  }
  const urlActivityMatch = trimmed.match(/urn:li:activity:(\d+)/);
  if (urlActivityMatch) {
    return `urn:li:activity:${urlActivityMatch[1]}`;
  }
  const urlShareMatch = trimmed.match(/urn:li:share:(\d+)/);
  if (urlShareMatch) {
    return `urn:li:activity:${urlShareMatch[1]}`;
  }
  throw new Error(`URN de post non reconnu: ${postUrnOrId}`);
}

/**
 * Extracts a LinkedIn slug from a URL, URN, or slug string.
 * Returns the slug (e.g. "john-doe") or URN if already a URN.
 */
export function extractLinkedInSlug(urlOrSlug: string): string {
  if (!urlOrSlug || urlOrSlug.trim() === '') return '';

  try {
    const input = urlOrSlug.trim();

    if (input.startsWith('urn:li:')) {
      return input;
    }

    if (/^https?:\/\//i.test(input)) {
      const normalizedUrl = normalizeLinkedInProfileUrl(input);
      if (!normalizedUrl) {
        return '';
      }
      const matchIn = normalizedUrl.match(/\/in\/([^/]+)\//);
      const matchCompany = normalizedUrl.match(/\/company\/([^/]+)\//);
      if (matchIn) return matchIn[1];
      if (matchCompany) return matchCompany[1];
      console.warn(`[Utils] Cannot extract slug from normalized URL: ${normalizedUrl}`);
      return '';
    }

    if (input.includes('/')) {
      return input.split('/')[0];
    }

    return input;
  } catch (error) {
    console.error('[Utils] Slug extraction error:', error);
    return urlOrSlug.trim();
  }
}

const COMMENT_THREAD_URN_REGEX = /^urn:li:comment:\((activity|ugcPost):(\d+),(\d+)\)$/;

/**
 * Normalise un URN de fil de commentaire (réponse / like commentaire).
 * Conserve activity vs ugcPost comme dans les réponses Voyager (ne pas forcer activity).
 */
export function normalizeCommentThreadUrn(commentThreadUrnOrIds: string | null | undefined): string {
  if (!commentThreadUrnOrIds || typeof commentThreadUrnOrIds !== 'string') {
    throw new Error('URN de commentaire vide ou invalide');
  }
  const trimmed = commentThreadUrnOrIds.trim();
  const fullMatch = trimmed.match(COMMENT_THREAD_URN_REGEX);
  if (fullMatch) {
    const kind = fullMatch[1];
    const postId = fullMatch[2];
    const commentId = fullMatch[3];
    return `urn:li:comment:(${kind}:${postId},${commentId})`;
  }
  const twoParts = trimmed.split(',').map(s => s.trim().replace(/^.*(?:activity|ugcPost):?/, '').replace(/\).*$/, '').trim());
  if (twoParts.length >= 2) {
    const postId = twoParts[0].replace(/^.*:/, '');
    const commentId = twoParts[1];
    if (/^\d+$/.test(postId) && /^\d+$/.test(commentId)) {
      const kind = /ugcPost/i.test(trimmed) ? 'ugcPost' : 'activity';
      return `urn:li:comment:(${kind}:${postId},${commentId})`;
    }
  }
  throw new Error(`URN de commentaire invalide: ${commentThreadUrnOrIds}`);
}

/**
 * Normalizes a profile URN for mentions in Voyager comments/replies.
 * Returns urn:li:fsd_profile:ID format.
 */
export function normalizeProfileUrnForMention(profileUrnOrId: string | null | undefined): string {
  if (!profileUrnOrId || typeof profileUrnOrId !== 'string') {
    throw new Error('URN de profil vide ou invalide');
  }
  const trimmed = profileUrnOrId.trim();
  const fsdMatch = trimmed.match(/^urn:li:fsd_profile:(.+)$/);
  if (fsdMatch) return trimmed;
  const fsMatch = trimmed.match(/^urn:li:fs_profile:(.+)$/);
  if (fsMatch) return `urn:li:fsd_profile:${fsMatch[1]}`;
  const memberMatch = trimmed.match(/^urn:li:member:(.+)$/);
  if (memberMatch) return `urn:li:fsd_profile:${memberMatch[1]}`;
  if (/^[A-Za-z0-9_-]+$/.test(trimmed) && trimmed.length > 10) {
    return `urn:li:fsd_profile:${trimmed}`;
  }
  throw new Error(`URN de profil non reconnu pour mention: ${profileUrnOrId}`);
}

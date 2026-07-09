/**
 * En-têtes applicatifs Voyager pour un fetch exécuté DANS la page linkedin.com.
 *
 * Le navigateur fournit automatiquement cookie / user-agent / sec-ch-ua / sec-fetch /
 * referer / accept-language (ce sont des "forbidden headers" qu'un fetch ne peut pas
 * surcharger). On ne pose donc QUE les en-têtes spécifiques LinkedIn. Le csrf-token
 * est lu in-page depuis le cookie JSESSIONID (voir browser.ts).
 *
 * Logique (pageInstance / pemMetadata / x-li-track) portée de l'app d'origine.
 */
export type VoyagerContext =
  | 'people'
  | 'posts'
  | 'typeahead'
  | 'profile'
  | 'comments'
  | 'post_comments'
  | 'feed'
  | 'connections'
  | 'invite';

function randHex(n: number): string {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function pageInstanceHash(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let h = '';
  for (let i = 0; i < 22; i++) h += chars.charAt(Math.floor(Math.random() * chars.length));
  return h + '==';
}

const X_LI_LANG = process.env.LK_LANG || 'en_US';

export function buildAppHeaders(context: VoyagerContext): Record<string, string> {
  const timezoneOffset = new Date().getTimezoneOffset() / -60;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const trackingData: Record<string, unknown> = {
    clientVersion: '1.13.42216',
    mpVersion: '1.13.42216',
    osName: 'web',
    timezoneOffset,
    timezone,
    deviceFormFactor: 'DESKTOP',
    mpName: 'voyager-web',
    displayDensity: 1.046875,
    displayWidth: 1921.015625,
    displayHeight: 1080.375,
  };

  let pageInstance = 'urn:li:page:d_flagship3_search_srp_people;' + Date.now();
  let pemMetadata = 'Voyager - Search=search-results';
  let acceptHeader = 'application/vnd.linkedin.normalized+json+2.1';

  switch (context) {
    case 'posts':
      pageInstance = `urn:li:page:d_flagship3_search_srp_content;${pageInstanceHash()}`;
      pemMetadata = 'Voyager - Content SRP=search-results';
      break;
    case 'typeahead':
      pemMetadata = 'Voyager - Search Single Typeahead=defaultusecase-people';
      break;
    case 'comments':
    case 'post_comments':
      pageInstance = `urn:li:page:d_flagship3_detail_base;${pageInstanceHash()}`;
      pemMetadata = 'Voyager - Feed - Comments=load-comments';
      break;
    case 'feed':
      pageInstance = `urn:li:page:d_flagship3_feed;${pageInstanceHash()}`;
      pemMetadata = 'Voyager - Feed - Subsequent=subsequent-feed-updates';
      break;
    case 'connections':
      pageInstance = `urn:li:page:d_flagship3_people_connections;${pageInstanceHash()}`;
      pemMetadata = 'Voyager - My Network - Connections=connections';
      break;
    case 'invite':
      pageInstance = `urn:li:page:d_flagship3_profile_view_base;${pageInstanceHash()}`;
      pemMetadata = 'Voyager - Profile Actions=topcard-primary-connect-action-click,Voyager - Invitations - Actions=invite-send';
      break;
    case 'profile':
    case 'people':
    default:
      break;
  }

  const spanId = randHex(16);
  const pageForestId = randHex(32);

  const headers: Record<string, string> = {
    accept: acceptHeader,
    'x-li-lang': X_LI_LANG,
    'x-li-page-instance': pageInstance,
    'x-li-pageforestid': pageForestId,
    'x-li-pem-metadata': pemMetadata,
    'x-li-track': JSON.stringify(trackingData),
    'x-li-traceparent': `00-${pageForestId}-${spanId}-00`,
    'x-li-tracestate': `LinkedIn=${spanId}`,
    'x-restli-protocol-version': '2.0.0',
  };

  if (context === 'profile' || context === 'invite') headers['x-li-deco-include-micro-schema'] = 'true';

  return headers;
}

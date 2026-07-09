/**
 * Tests adversariaux des fonctions PURES critiques (aucun réseau, aucun fichier).
 * On cible les endroits où vivent les bugs de cas particuliers : parsing d'URL/URN,
 * lecture de l'état de relation, échappement CSV, marques de suivi.
 *
 * Lancer : npm test   (node --import tsx --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractLinkedInSlug,
  normalizeLinkedInProfileUrl,
  normalizeProfileUrnForMention,
  isValidPostUrn,
  normalizePostUrnForVoyager,
  normalizePersonName,
} from '../src/voyager/linkedin-urls.js';
import { parseMemberRelationship, parsePeopleSearch } from '../src/voyager/parse.js';
import { csvEscape, invitedMark, acceptedMark } from '../src/store.js';

/* ---------- extractLinkedInSlug ---------- */
test('extractLinkedInSlug: URLs, casse, sous-domaine, params, /company', () => {
  assert.equal(extractLinkedInSlug('https://www.linkedin.com/in/john-doe/'), 'john-doe');
  assert.equal(extractLinkedInSlug('https://linkedin.com/in/john-doe'), 'john-doe');
  assert.equal(extractLinkedInSlug('https://fr.linkedin.com/in/john-doe/?utm=x'), 'john-doe');
  assert.equal(extractLinkedInSlug('HTTPS://LinkedIn.com/IN/John-Doe/'), 'john-doe');
  assert.equal(extractLinkedInSlug('https://www.linkedin.com/company/acme/'), 'acme');
  assert.equal(extractLinkedInSlug('john-doe'), 'john-doe');
});
test('extractLinkedInSlug: URN passe tel quel, vide → vide', () => {
  assert.equal(extractLinkedInSlug('urn:li:fsd_profile:ACoAA123'), 'urn:li:fsd_profile:ACoAA123');
  assert.equal(extractLinkedInSlug(''), '');
  assert.equal(extractLinkedInSlug('   '), '');
});

/* ---------- normalizeLinkedInProfileUrl ---------- */
test('normalizeLinkedInProfileUrl: rejette les URLs de POST, normalise les profils', () => {
  assert.equal(normalizeLinkedInProfileUrl('https://www.linkedin.com/feed/update/urn:li:activity:123'), '');
  assert.equal(normalizeLinkedInProfileUrl('https://www.linkedin.com/posts/foo-bar-123'), '');
  assert.equal(normalizeLinkedInProfileUrl(''), '');
  assert.equal(normalizeLinkedInProfileUrl('https://www.linkedin.com/in/Jane/'), 'https://linkedin.com/in/jane/');
  assert.equal(normalizeLinkedInProfileUrl('not a url'), '');
});

/* ---------- normalizeProfileUrnForMention (cause des 2 échecs "LinkedIn Member") ---------- */
test('normalizeProfileUrnForMention: formes valides', () => {
  assert.equal(normalizeProfileUrnForMention('urn:li:fsd_profile:ACoAA123'), 'urn:li:fsd_profile:ACoAA123');
  assert.equal(normalizeProfileUrnForMention('urn:li:fs_profile:ACoAA9'), 'urn:li:fsd_profile:ACoAA9');
  assert.equal(normalizeProfileUrnForMention('urn:li:member:12345'), 'urn:li:fsd_profile:12345');
  assert.equal(normalizeProfileUrnForMention('ACoAABeLUJ4BbhANqs4'), 'urn:li:fsd_profile:ACoAABeLUJ4BbhANqs4');
});
test('normalizeProfileUrnForMention: rejette vide / non-profil / id tronqué', () => {
  for (const bad of ['', '   ', 'urn:li:fsd_profile:', 'urn:li:company:1', 'garbage!', 'short']) {
    assert.throws(() => normalizeProfileUrnForMention(bad), undefined, `devrait throw sur ${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeProfileUrnForMention(null as any));
});

/* ---------- post URNs ---------- */
test('isValidPostUrn', () => {
  assert.equal(isValidPostUrn('urn:li:activity:123'), true);
  assert.equal(isValidPostUrn('urn:li:ugcPost:123'), true);
  assert.equal(isValidPostUrn('urn:li:member:1'), false);
  assert.equal(isValidPostUrn('urn:li:fsd_profile:x'), false);
  assert.equal(isValidPostUrn(''), false);
  assert.equal(isValidPostUrn(null), false);
});
test('normalizePostUrnForVoyager: id nu, share→activity, throw', () => {
  assert.equal(normalizePostUrnForVoyager('123'), 'urn:li:activity:123');
  assert.equal(normalizePostUrnForVoyager('urn:li:ugcPost:5'), 'urn:li:ugcPost:5');
  assert.equal(normalizePostUrnForVoyager('urn:li:share:9'), 'urn:li:activity:9');
  assert.equal(normalizePostUrnForVoyager('urn:li:activity:7'), 'urn:li:activity:7');
  assert.throws(() => normalizePostUrnForVoyager(''));
  assert.throws(() => normalizePostUrnForVoyager('garbage'));
});

/* ---------- normalizePersonName ---------- */
test('normalizePersonName: espaces multiples, casse, vide', () => {
  assert.equal(normalizePersonName('  John   Doe  '), 'john doe');
  assert.equal(normalizePersonName('ÉLODIE Martin'), 'élodie martin');
  assert.equal(normalizePersonName(''), '');
});

/* ---------- parseMemberRelationship (cœur de check-accepted) ---------- */
test('parseMemberRelationship: connected via *connection', () => {
  const r = parseMemberRelationship({ data: { memberRelationshipUnion: { '*connection': 'urn:li:fsd_connection:X' } } });
  assert.deepEqual(r, { status: 'connected', distance: 1 });
});
test('parseMemberRelationship: pending (noConnection + invitation)', () => {
  const r = parseMemberRelationship({
    data: { memberRelationshipUnion: { noConnection: { memberDistance: 'DISTANCE_3', invitationUnion: { '*invitation': 'urn:li:fsd_invitation:1' } } } },
  });
  assert.deepEqual(r, { status: 'pending', distance: 3 });
});
test('parseMemberRelationship: none (noConnection sans invitation)', () => {
  const r = parseMemberRelationship({ data: { memberRelationshipUnion: { noConnection: { memberDistance: 'DISTANCE_2' } } } });
  assert.deepEqual(r, { status: 'none', distance: 2 });
});
test('parseMemberRelationship: self / unknown / manquant / non enveloppé', () => {
  assert.equal(parseMemberRelationship({ data: { memberRelationshipUnion: { self: {} } } }).status, 'self');
  assert.equal(parseMemberRelationship({ data: {} }).status, 'unknown');
  assert.equal(parseMemberRelationship({}).status, 'unknown');
  assert.equal(parseMemberRelationship(null).status, 'unknown');
  // forme non enveloppée dans data
  assert.equal(parseMemberRelationship({ memberRelationshipUnion: { '*connection': 'x' } }).status, 'connected');
});

/* ---------- parsePeopleSearch : mapping du degré ---------- */
function peopleResp(memberDistance: string) {
  return {
    included: [
      {
        title: 'John Doe',
        primarySubtitle: 'CEO',
        navigationUrl: 'https://www.linkedin.com/in/johndoe/',
        entityCustomTrackingInfo: { memberDistance },
      },
    ],
  };
}
test('parsePeopleSearch: DISTANCE_1/2/3/OUT + nom/url', () => {
  const p1 = parsePeopleSearch(peopleResp('DISTANCE_1'));
  assert.equal(p1.length, 1);
  assert.equal(p1[0].name, 'John Doe');
  assert.equal(p1[0].degree, 1);
  assert.equal(p1[0].profileUrl, 'https://linkedin.com/in/johndoe/');
  assert.equal(parsePeopleSearch(peopleResp('DISTANCE_2'))[0].degree, 2);
  assert.equal(parsePeopleSearch(peopleResp('DISTANCE_3'))[0].degree, 3);
  assert.equal(parsePeopleSearch(peopleResp('OUT_OF_NETWORK'))[0].degree, 0);
  assert.equal(parsePeopleSearch(peopleResp('BOGUS'))[0].degree, undefined);
});
test('parsePeopleSearch: réponse vide / included absent', () => {
  assert.deepEqual(parsePeopleSearch({}), []);
  assert.deepEqual(parsePeopleSearch({ included: [] }), []);
  assert.deepEqual(parsePeopleSearch(null), []);
});

/* ---------- csvEscape ---------- */
test('csvEscape: virgules, guillemets, retours-ligne, null, nombres', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvEscape('l1\nl2'), '"l1 l2"');
  assert.equal(csvEscape('l1\r\nl2'), '"l1 l2"');
  assert.equal(csvEscape(null), '""');
  assert.equal(csvEscape(undefined), '""');
  assert.equal(csvEscape(5), '"5"');
  assert.equal(csvEscape(''), '""');
  // caractère hors BMP (paire surrogate) : ne doit pas casser
  assert.equal(csvEscape('a\u{1D400}b'), '"a\u{1D400}b"');
});

/* ---------- invitedMark / acceptedMark ---------- */
test('invitedMark / acceptedMark: matrice des états', () => {
  const cases: [any, string, string][] = [
    [{ invitationStatus: 'pending' }, 'x', ''],
    [{ invitationStatus: 'accepted' }, 'x', 'x'],
    [{ degree: 1 }, '', 'x'],
    [{ invitedAt: '2026-07-09T00:00:00Z' }, 'x', ''],
    [{ degree: 2, invitationStatus: 'pending' }, 'x', ''],
    [{}, '', ''],
  ];
  for (const [lead, inv, acc] of cases) {
    assert.equal(invitedMark(lead), inv, `invitedMark ${JSON.stringify(lead)}`);
    assert.equal(acceptedMark(lead), acc, `acceptedMark ${JSON.stringify(lead)}`);
  }
});

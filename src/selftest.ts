/** Tests rapides hors-réseau : scoring générique, classification, parsers, géo, URN. */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { scoreLead } from './score.js';
import { classify } from './classify.js';
import { saveProfile, resetProfile, DEFAULT_GROUPS, PROFILE_FILE } from './profile.js';
import { resolveGeo } from './voyager/endpoints.js';
import { parsePostSearch, parseComments, parsePeopleSearch } from './voyager/parse.js';
import { normalizePostUrnForVoyager } from './voyager/linkedin-urls.js';

let failed = 0;
function check(name: string, cond: boolean | undefined, detail?: unknown) {
  const ok = !!cond;
  process.stdout.write(`${ok ? '✅' : '❌'} ${name}${ok ? '' : '  -> ' + JSON.stringify(detail)}\n`);
  if (!ok) failed++;
}

// Sauvegarde du profil actif réel : les tests le mutent, on le restaure à la fin.
const _profileBackup = existsSync(PROFILE_FILE) ? readFileSync(PROFILE_FILE, 'utf8') : null;

// --- scoring par règles (profil avec scoreRules) ---
resetProfile();
saveProfile({
  scoreRules: [
    { tag: 'cost', weight: 4, patterns: ['\\bcost\\b', 'expensive', 'budget'] },
    { tag: 'role', weight: 2, patterns: ['founder', 'cto'] },
  ],
});
const r1 = scoreLead(['Founder & CTO at startup', 'our cloud cost is too expensive']);
check('scoring règles: score 6', r1.score === 6, r1);
check('scoring règles: tags', r1.tags.includes('cost') && r1.tags.includes('role'), r1.tags);
const r2 = scoreLead(['Marketing manager', 'love coffee']);
check('scoring règles: froid 0', r2.score === 0, r2);

// --- scoring par recouvrement de mots-clés (aucune règle) ---
resetProfile();
saveProfile({ keywords: ['LLM inference', 'data privacy'], scoreRules: [] }, { mergeKeywords: false });
const r3 = scoreLead(['We optimize LLM inference pipelines at scale']);
check('scoring overlap: match 1 kw', r3.score === 1 && r3.tags.includes('LLM inference'), r3);
const r4 = scoreLead(['random unrelated text']);
check('scoring overlap: 0', r4.score === 0, r4);

// --- classification : groupes par défaut ---
resetProfile();
check('classify default groups', DEFAULT_GROUPS.length === 2);
check('classify decision_maker', classify('Co-founder & CEO at Acme') === 'decision_maker');
check('classify practitioner', classify('Senior Software Engineer') === 'practitioner');
check('classify other', classify('Photographer & barista') === 'other');
// --- classification : groupes custom (n'importe quel cas d'usage) ---
saveProfile({ groups: [{ name: 'doctor', patterns: ['\\bMD\\b', 'physician', 'surgeon'] }] });
check('classify custom group', classify('Cardiac surgeon, MD') === 'doctor');
check('classify custom fallback other', classify('Software Engineer') === 'other');
resetProfile();

// --- géo générique ---
check('geo nom -> urn', resolveGeo('United States')?.urn === '103644278');
check('geo urn brut passthrough', resolveGeo('90000084')?.urn === '90000084');
check('geo inconnu -> null', resolveGeo('Atlantis') === null);

// --- URN normalization ---
check('normalizePostUrn activity', normalizePostUrnForVoyager('urn:li:activity:7300000000000000000').includes('activity:7300000000000000000'));

// --- parser posts ---
const fakePosts = {
  data: { data: { searchDashClustersByAll: { elements: [] } } },
  included: [
    {
      entityUrn: 'urn:li:activity:7300000000000000001',
      commentary: { text: 'We burn millions of tokens daily on inference.' },
      actor: {
        name: { text: 'Jane Builder' },
        description: { text: 'Co-founder & CTO, infra startup (SF)' },
        navigationContext: { actionTarget: 'https://www.linkedin.com/in/jane-builder/' },
        urn: 'urn:li:member:123',
      },
      numLikes: 42,
      numComments: 7,
    },
  ],
};
const posts = parsePostSearch(fakePosts);
check('parsePostSearch 1 post', posts.length === 1, posts.length);
check('parsePostSearch auteur nom', posts[0]?.author.name === 'Jane Builder', posts[0]?.author);
check('parsePostSearch headline', !!posts[0]?.author.headline, posts[0]?.author.headline);
check('parsePostSearch url vanity directe', posts[0]?.author.profileUrl?.includes('/in/jane-builder'), posts[0]?.author.profileUrl);
check('parsePostSearch counts', posts[0]?.reactions === 42 && posts[0]?.comments === 7, posts[0]);

// --- parser commentaires ---
const fakeComments = {
  included: [
    {
      commentary: { text: 'Same here, the bill is insane.' },
      commenter: { title: { text: 'Bob Engineer' }, subtitle: 'Staff ML Engineer @ SeedCo', navigationUrl: 'https://www.linkedin.com/in/bob-eng/', urn: 'urn:li:fsd_profile:ACoAABoBeng' },
    },
    { commentary: { text: 'nice post' }, commenter: { title: { text: 'Temp Person' }, urn: 'urn:li:fsd_profile:ACoAACtemp123' } },
  ],
};
const comments = parseComments(fakeComments, 'urn:li:activity:7300000000000000001');
check('parseComments 2', comments.length === 2, comments.length);
check('parseComments url directe', comments[0]?.author.profileUrl?.includes('/in/bob-eng'), comments[0]?.author);
check('parseComments urn temp pour 2e', comments[1]?.author.profileUrn?.includes('ACoAACtemp123'), comments[1]?.author);

// --- parser people ---
const fakePeople = {
  included: [
    { title: { text: 'Alice AI' }, primarySubtitle: { text: 'Founder, AI agents startup' }, navigationUrl: 'https://www.linkedin.com/in/alice-ai/', entityUrn: 'urn:li:fsd_profile:ACoAAalice', entityCustomTrackingInfo: { memberDistance: 'DISTANCE_1' } },
    { title: { text: 'Bob Far' }, primarySubtitle: { text: 'CTO' }, navigationUrl: 'https://www.linkedin.com/in/bob-far/', entityCustomTrackingInfo: { memberDistance: 'DISTANCE_3' } },
  ],
};
const people = parsePeopleSearch(fakePeople);
check('parsePeopleSearch 2', people.length === 2, people.length);
check('parsePeopleSearch url', people[0]?.profileUrl?.includes('/in/alice-ai'), people[0]);
check('parsePeopleSearch degree 1 (connecté)', people[0]?.degree === 1, people[0]?.degree);
check('parsePeopleSearch degree 3 (non connecté)', people[1]?.degree === 3, people[1]?.degree);

// Restaure le profil actif tel qu'il était avant les tests (aucun effet de bord sur l'état réel).
if (_profileBackup !== null) writeFileSync(PROFILE_FILE, _profileBackup);
else rmSync(PROFILE_FILE, { force: true });

process.stdout.write(failed ? `\n${failed} test(s) en échec\n` : '\nTous les tests passent ✅\n');
process.exitCode = failed ? 1 : 0;

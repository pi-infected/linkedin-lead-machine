#!/usr/bin/env -S npx tsx
/**
 * CLI générique de lead-gen LinkedIn. AUCUN cas d'usage codé en dur : la cible
 * (ICP) vit dans le PROFIL ACTIF (state/profile.json), que l'AGENT compose après
 * discussion avec l'utilisateur. Le moteur ne fait qu'exposer des fonctions —
 * recherche, collecte, scoring, classification, export — l'agent les enchaîne.
 *
 * Philosophie : chaque commande fait UN petit bout de travail (une page), écrit
 * le détail dans data/*.jsonl, et n'imprime qu'un RÉSUMÉ compact. L'agent lit
 * ensuite les fichiers morceau par morceau pour ne pas saturer son contexte.
 *
 * Les timings entre requêtes sont appliqués par l'outil (voir ratelimit.ts) :
 * relancer ces commandes en rafale n'accélère rien, l'outil attend tout seul.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  searchPosts,
  searchPeople,
  getComments,
  resolveProfileUrl,
  resolveMemberProfileUrn,
  resolveGeo,
  sendInvitation,
  sendMessage,
  getMemberRelationship,
  conversationHasReply,
  getRecentConversationParticipants,
  conversationFirstFromSelf,
  DateFilter,
} from './voyager/endpoints.js';
import {
  upsertLead,
  appendPost,
  appendComment,
  getLeads,
  getPosts,
  markResolved,
  markPriorConversation,
  promoteLeadUrn,
  setSemanticScores,
  rescoreAll,
  exportLeads,
  getInvitable,
  getPendingInvites,
  markInvited,
  markAcceptedMany,
  markRelCheckedMany,
  getMessageable,
  markMessaged,
  getFollowupable,
  markFollowedUp,
  getReplyCheckable,
  markRepliedMany,
  markReplyCheckedMany,
  LeadRecord,
} from './store.js';
import { extractLinkedInSlug } from './voyager/linkedin-urls.js';
import { postIsRelevant, scoreLead } from './score.js';
import { semanticSimilarities, semanticBonus, PAIN_REFS } from './semantic.js';
import { getProfile, saveProfile, resetProfile, ScoreRule, Group } from './profile.js';
import { getStatus, DailyCapReached, isInmailExhaustedToday, markInmailExhaustedToday } from './ratelimit.js';
import { TokenInvalidError, NotLoggedInError } from './voyager/client.js';
import { isLoggedIn, interactiveLogin, seedCookiesFromFile, closeBrowser } from './voyager/browser.js';
import { ROOT } from './config.js';

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function num(v: string | boolean | undefined, def: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isNaN(n) ? def : n;
}
function list(v: string | boolean | undefined): string[] {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}
function readJsonArg<T>(v: string | boolean | undefined): T | undefined {
  if (typeof v !== 'string') return undefined;
  const text = v.trim().startsWith('[') || v.trim().startsWith('{') ? v : readFileSync(resolve(v), 'utf8');
  return JSON.parse(text) as T;
}
function out(obj: unknown) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
function fail(msg: string) {
  process.stderr.write(msg + '\n');
  process.exitCode = 1;
}

/** Résout un filtre géo depuis un drapeau (--geo name|urn). Renvoie {urn,label} ou null. */
function geoFrom(flag: string | boolean | undefined): { urn: string; label: string } | null {
  if (typeof flag !== 'string') return null;
  return resolveGeo(flag);
}

/**
 * Résout des cibles données en argument (URL vanity, URN, ACoAA... ou slug) vers
 * les leads stockés — pour agir sur des profils PRÉCIS. Match par slug (profileUrl)
 * ou par profileUrn. Un URN brut hors store reste utilisable (invitation possible),
 * mais sans nom (donc check-accepted, qui recherche par nom, le sautera).
 */
function resolveTargets(targets: string[]): { input: string; lead?: LeadRecord; name?: string; profileUrn?: string }[] {
  const leads = getLeads();
  const bySlug = new Map<string, LeadRecord>();
  const byUrn = new Map<string, LeadRecord>();
  for (const l of leads) {
    if (l.profileUrl) {
      const s = extractLinkedInSlug(l.profileUrl);
      if (s) bySlug.set(s.toLowerCase(), l);
    }
    if (l.profileUrn) byUrn.set(l.profileUrn, l);
  }
  return targets.map((t) => {
    const raw = t.trim();
    const acoaa = raw.match(/ACoAA[A-Za-z0-9_-]+/)?.[0];
    if (raw.startsWith('urn:li:') || acoaa) {
      const urn = raw.startsWith('urn:') ? raw : `urn:li:fsd_profile:${acoaa}`;
      const lead = byUrn.get(urn);
      return { input: raw, lead, name: lead?.name, profileUrn: lead?.profileUrn || urn };
    }
    const slug = (extractLinkedInSlug(raw) || '').toLowerCase();
    const lead = slug ? bySlug.get(slug) : undefined;
    return { input: raw, lead, name: lead?.name, profileUrn: lead?.profileUrn };
  });
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];

  switch (cmd) {
    /* ---------- session ---------- */
    case 'seed-cookies': {
      const path = _[1] ? resolve(_[1]) : resolve(ROOT, 'cookies');
      const r = await seedCookiesFromFile(path);
      out({ seeded: r.count, from: path, cookies: r.names, hint: 'Session prête. Vérifie avec `whoami`, puis lance une recherche.' });
      break;
    }
    case 'login': {
      const ok = await interactiveLogin();
      out({ loggedIn: ok, hint: ok ? 'Session enregistrée dans le profil persistant.' : 'Timeout — réessaie `login`.' });
      if (!ok) process.exitCode = 1;
      break;
    }
    case 'whoami': {
      const ok = await isLoggedIn();
      out({ loggedIn: ok, hint: ok ? 'Session LinkedIn active.' : 'Pas de session : lance `seed-cookies` ou `login`.' });
      if (!ok) process.exitCode = 1;
      break;
    }
    case 'status': {
      const st = getStatus();
      const leads = getLeads();
      const p = getProfile();
      out({
        daily: st.daily,
        cooldownRemainingSec: Math.round(st.cooldownRemainingMs / 1000),
        profile: { icp: p.icp, keywords: p.keywords.length, geo: p.geoLabel, groups: p.groups.map((g) => g.name), minScore: p.minScore },
        leads: { total: leads.length, geoConfirmed: leads.filter((l) => l.geo).length, resolved: leads.filter((l) => l.resolved).length },
      });
      break;
    }

    /* ---------- géo ---------- */
    case 'geo': {
      const q = _.slice(1).join(' ');
      if (!q) return fail('Usage: geo "<lieu>"   (ex: "United States", "London Area", ou un geoUrn brut)');
      const g = resolveGeo(q);
      out(
        g
          ? { query: q, geoUrn: g.urn, label: g.label, hint: 'Passe ce geoUrn à `campaign --geo` ou `search-people --geo`.' }
          : { query: q, geoUrn: null, hint: 'Lieu inconnu de la table. Donne un geoUrn brut (chiffres), extractible d\'une URL de recherche LinkedIn filtrée (&geoUrn=...).' },
      );
      break;
    }

    /* ---------- profil (l'ICP, composé par l'agent) ---------- */
    case 'profile': {
      const sub = _[1] || 'show';
      if (sub === 'show') {
        out(getProfile());
        break;
      }
      if (sub === 'reset') {
        out({ reset: true, profile: resetProfile() });
        break;
      }
      if (sub === 'set') {
        const patch: any = {};
        // --file <profile.json|inline> : charge un profil COMPLET (ex: examples/*.json), puis les flags surchargent.
        const fileProfile = readJsonArg<Partial<typeof patch>>(flags.file);
        if (fileProfile) Object.assign(patch, fileProfile);
        if (typeof flags.icp === 'string') patch.icp = flags.icp;
        if (typeof flags.keywords === 'string') patch.keywords = list(flags.keywords);
        if (typeof flags.geo === 'string') {
          const g = geoFrom(flags.geo);
          if (!g) return fail(`geo inconnu: "${flags.geo}". Utilise \`geo "<lieu>"\` ou un geoUrn brut.`);
          patch.geoUrn = g.urn;
          patch.geoLabel = g.label;
        }
        if (flags['no-geo']) {
          patch.geoUrn = null;
          patch.geoLabel = null;
        }
        if (flags['min-score'] !== undefined) patch.minScore = num(flags['min-score'], 0);
        const rules = readJsonArg<ScoreRule[]>(flags.rules);
        if (rules) patch.scoreRules = rules;
        const groups = readJsonArg<Group[]>(flags.groups);
        if (groups) patch.groups = groups;
        const next = saveProfile(patch, { mergeKeywords: !flags['replace-keywords'] });
        out({ saved: true, profile: next });
        break;
      }
      return fail('Usage: profile show | set [--file <profile.json>] [--icp "..."] [--keywords a,b] [--geo name|urn|--no-geo] [--min-score N] [--rules <json|file>] [--groups <json|file>] [--replace-keywords] | reset');
    }

    /* ---------- recherche unitaire ---------- */
    case 'search-posts': {
      const kw = _[1];
      if (!kw) return fail('Usage: search-posts "<mots-clés>" [--start N] [--count N] [--date past-24h|past-week|past-month]');
      const page = await searchPosts(kw, { start: num(flags.start, 0), count: num(flags.count, 5), dateFilter: (flags.date as DateFilter) || null });
      let newLeads = 0;
      const relevantPosts: { postUrn?: string; author: string; relevant: boolean; reactions?: number; comments?: number }[] = [];
      for (const p of page.posts) {
        appendPost(p);
        const relevant = postIsRelevant(p.text, p.author.headline);
        const r = upsertLead(p.author, [p.author.headline || '', p.text.slice(0, 240)]);
        if (r.isNew) newLeads++;
        relevantPosts.push({ postUrn: p.postUrn, author: p.author.name, relevant, reactions: p.reactions, comments: p.comments });
      }
      out({
        query: kw,
        page: { start: num(flags.start, 0), count: num(flags.count, 5), nextStart: page.nextStart },
        postsFound: page.posts.length,
        newLeads,
        rawFile: page.rawFile,
        posts: relevantPosts,
        hint: 'Détail dans data/posts.jsonl et data/people.jsonl. Commentateurs des posts pertinents : `comments <postUrn>`.',
      });
      break;
    }
    case 'search-people': {
      const kw = _[1];
      if (!kw) return fail('Usage: search-people "<mots-clés>" [--start N] [--count N] [--geo name|urn]');
      const g = geoFrom(flags.geo);
      const page = await searchPeople(kw, { start: num(flags.start, 0), count: num(flags.count, 10), geoUrn: g?.urn });
      let newLeads = 0;
      for (const person of page.people) {
        const r = upsertLead(person, [person.headline || ''], { geo: g?.label, segment: typeof flags.segment === 'string' ? flags.segment : undefined });
        if (r.isNew) newLeads++;
      }
      out({ query: kw, geo: g?.label || null, peopleFound: page.people.length, newLeads, nextStart: page.nextStart, rawFile: page.rawFile, hint: 'Leads dans data/people.jsonl (commande `leads`).' });
      break;
    }
    case 'comments': {
      const postUrn = _[1];
      if (!postUrn) return fail('Usage: comments <postUrn|activityId> [--start N] [--count N] [--geo name|urn] [--segment X]');
      const known = getPosts().find((p) => p.postUrn === postUrn || p.ugcPostUrn === postUrn || p.socialDetailUrn === postUrn);
      const target = known?.socialDetailUrn || known?.ugcPostUrn || postUrn;
      const page = await getComments(target, { start: num(flags.start, 0), count: num(flags.count, 10), postUrnLabel: known?.postUrn || postUrn });
      const cg = geoFrom(flags.geo);
      const cseg = typeof flags.segment === 'string' ? flags.segment : undefined;
      let newLeads = 0;
      let relevant = 0;
      for (const c of page.comments) {
        appendComment(c);
        const r = upsertLead(c.author, [c.author.headline || '', c.text.slice(0, 240)], { geo: cg?.label, segment: cseg });
        if (r.isNew) newLeads++;
        if (postIsRelevant(c.text, c.author.headline)) relevant++;
      }
      out({ postUrn, commentsFound: page.comments.length, relevantCommenters: relevant, newLeads, nextStart: page.nextStart, rawFile: page.rawFile, hint: 'Détail dans data/comments.jsonl ; nouveaux leads dans data/people.jsonl.' });
      break;
    }

    /* ---------- campagne (orchestration multi-mots-clés en un seul process) ---------- */
    case 'campaign': {
      const mode = (typeof flags.mode === 'string' ? flags.mode : 'people') as 'people' | 'posts';
      const profile = getProfile();
      const keywords = list(flags.keywords).length ? list(flags.keywords) : profile.keywords;
      if (!keywords.length) return fail('Aucun mot-clé. Donne --keywords "a,b,c" ou configure le profil (`profile set --keywords ...`).');
      const g = geoFrom(flags.geo) || (profile.geoUrn ? { urn: profile.geoUrn, label: profile.geoLabel || profile.geoUrn } : null);
      const target = num(flags.target, 0); // nb de prospects voulu ; 0 = pas de cible (borné par --pages)
      const pages = num(flags.pages, target > 0 ? 12 : 3);
      const perPage = num(flags['per-page'], mode === 'people' ? 10 : 5);
      // mémorise le vocabulaire + le géo dans le profil actif
      saveProfile({ keywords, geoUrn: g?.urn ?? profile.geoUrn, geoLabel: g?.label ?? profile.geoLabel });

      let calls = 0;
      let newLeads = 0;
      let stopped = false;
      let reachedTarget = false;
      const relevantPosts: { socialDetailUrn?: string; ugcPostUrn?: string; postUrn?: string }[] = [];

      outer: for (const kw of keywords) {
        for (let page = 0; page < pages; page++) {
          try {
            if (mode === 'people') {
              const res = await searchPeople(kw, { start: page * perPage, count: perPage, geoUrn: g?.urn });
              calls++;
              if (!res.people.length) break;
              for (const person of res.people) {
                const r = upsertLead(person, [person.headline || ''], { geo: g?.label, segment: typeof flags.segment === 'string' ? flags.segment : undefined });
                if (r.isNew) newLeads++;
              }
            } else {
              const res = await searchPosts(kw, { start: page * perPage, count: perPage });
              calls++;
              if (!res.posts.length) break;
              for (const p of res.posts) {
                appendPost(p);
                const r = upsertLead(p.author, [p.author.headline || '', p.text.slice(0, 240)]);
                if (r.isNew) newLeads++;
                if (p.postUrn && postIsRelevant(p.text, p.author.headline)) {
                  relevantPosts.push({ socialDetailUrn: p.socialDetailUrn, ugcPostUrn: p.ugcPostUrn, postUrn: p.postUrn });
                }
              }
            }
          } catch (e: any) {
            if (e instanceof DailyCapReached) {
              stopped = true;
              break outer;
            }
            process.stderr.write(`[campaign] erreur "${kw}" p${page}: ${e?.message || e}\n`);
          }
          if (target > 0 && newLeads >= target) { reachedTarget = true; break outer; }
        }
      }

      // mode posts : récolte optionnelle des commentateurs des posts pertinents
      let commenters = 0;
      if (mode === 'posts' && flags.comments && !stopped && !reachedTarget) {
        const cap = num(flags['max-comment-posts'], 40);
        for (const t of relevantPosts.slice(0, cap)) {
          try {
            const res = await getComments(t.socialDetailUrn || t.ugcPostUrn || t.postUrn!, { count: 10, postUrnLabel: t.postUrn });
            calls++;
            for (const c of res.comments) {
              appendComment(c);
              const r = upsertLead(c.author, [c.author.headline || '', c.text.slice(0, 240)], { geo: g?.label, segment: typeof flags.segment === 'string' ? flags.segment : undefined });
              if (r.isNew) { newLeads++; commenters++; }
            }
          } catch (e: any) {
            if (e instanceof DailyCapReached) { stopped = true; break; }
            process.stderr.write(`[campaign] commentaires ${t.postUrn}: ${e?.message || e}\n`);
          }
        }
      }

      const minScore = num(flags['min-score'], profile.minScore || 0);
      const exp = exportLeads({ minScore, split: !flags['no-split'] });
      const all = getLeads();
      out({
        mode,
        keywords: keywords.length,
        geo: g?.label || null,
        calls,
        target: target || undefined,
        newLeads,
        reachedTarget: reachedTarget || undefined,
        commenters: mode === 'posts' ? commenters : undefined,
        stoppedByDailyCap: stopped || undefined,
        totals: { leads: all.length, geoConfirmed: all.filter((l) => l.geo).length },
        export: { combined: exp.combined, groups: exp.groups, connection: exp.connection, minScore },
        hint: 'CSV dans data/. Relance avec d\'autres --keywords pour élargir, ou demain quand le quota repart.',
      });
      break;
    }

    /* ---------- résolution d'URL vanity (parcimonieux, endpoint surveillé) ---------- */
    case 'resolve': {
      const target = _[1];
      if (!target) return fail('Usage: resolve <urn|ACoAA...|profileKey>');
      const r = await resolveProfileUrl(target);
      if (r.profileUrl) markResolved(target, r.profileUrl);
      out({ target, profileUrl: r.profileUrl, publicIdentifier: r.publicIdentifier, rawFile: r.rawFile });
      break;
    }
    case 'semantic-rescore': {
      // Crédite la DOULEUR exprimée (commentaire + headline) : score = score
      // mots-clés + bonus de similarité sémantique au concept-douleur (potion).
      // Offline : lit l'evidence déjà stockée, aucun appel LinkedIn.
      const seg = typeof flags.segment === 'string' ? flags.segment : undefined;
      const floor = flags['sim-floor'] !== undefined ? Number(flags['sim-floor']) : 0.25;
      const gain = flags['sim-gain'] !== undefined ? Number(flags['sim-gain']) : 12;
      const cap = flags['sim-cap'] !== undefined ? Number(flags['sim-cap']) : 6;
      let leads = getLeads().filter((l) => !!l.profileUrn && (l.evidence?.length || l.headline));
      if (seg) leads = leads.filter((l) => l.segment === seg);
      if (!leads.length) { out({ scored: 0, hint: 'Aucun lead à scorer (filtre --segment ?).' }); break; }
      const items = leads.map((l) => ({ key: l.profileUrn!, text: [l.headline || '', ...(l.evidence || [])].join(' · ').slice(0, 512) }));
      const sem = semanticSimilarities(items, PAIN_REFS);
      if (!sem.ok) return fail(`Score sémantique indisponible: ${sem.error}. (Python3 + \`pip install model2vec\` requis ; le modèle se télécharge à la demande.)`);
      const byUrn: Record<string, { score: number; patternScore: number; sim: number }> = {};
      let promoted3 = 0; const hist: Record<string, number> = {};
      for (const l of leads) {
        const sim = sem.sims[l.profileUrn!] ?? 0;
        const patternScore = scoreLead([l.headline || '', ...(l.evidence || [])].filter(Boolean) as string[]).score;
        const bonus = semanticBonus(sim, floor, gain, cap);
        const score = patternScore + bonus;
        byUrn[l.profileUrn!] = { score, patternScore, sim };
        if (patternScore < 3 && score >= 3) promoted3++;
        const b = sim < 0.25 ? '<.25' : sim < 0.4 ? '.25-.4' : sim < 0.55 ? '.4-.55' : '>=.55';
        hist[b] = (hist[b] || 0) + 1;
      }
      const n = setSemanticScores(byUrn);
      out({ scored: n, crossedToScore3: promoted3, simFloor: floor, simGain: gain, simCap: cap, simDistribution: hist, hint: 'score = mots-clés + bonus sémantique (douleur). Idempotent. Ajuste --sim-floor/--sim-gain/--sim-cap. Puis `invite --segment <X> --min-score 3`.' });
      break;
    }
    case 'resolve-members': {
      // Promeut les leads récoltés via commentaires (urn:li:member:NNNN, non
      // invitables) vers leur URN fsd_profile (ACoAA...) via le lookup vanity.
      const minScore = num(flags['min-score'], 0);
      const seg = typeof flags.segment === 'string' ? flags.segment : undefined;
      const limit = num(flags.limit, 40);
      let cand = getLeads().filter(
        (l) =>
          !!l.profileUrn &&
          /urn:li:member:\d+/.test(l.profileUrn) &&
          !l.resolved &&
          !!l.profileUrl &&
          l.score >= minScore,
      );
      if (seg) cand = cand.filter((l) => l.segment === seg);
      cand = cand.slice(0, limit);
      if (!cand.length) { out({ pool: 0, promoted: 0, hint: 'Aucun lead member à promouvoir (déjà résolus, sans vanity, ou score < --min-score).' }); break; }
      let promoted = 0, failed = 0, stopped = false;
      const results: any[] = [];
      for (const l of cand) {
        try {
          const r = await resolveMemberProfileUrn(l.profileUrl!);
          if (r.profileUrn) { promoteLeadUrn(l.profileUrn!, r.profileUrn); promoted++; results.push({ name: l.name, profileUrn: r.profileUrn }); }
          else { failed++; results.push({ name: l.name, error: 'pas d\'ACoAA résolu' }); }
        } catch (e: any) {
          if (e instanceof DailyCapReached) { stopped = true; break; }
          failed++; results.push({ name: l.name, error: e?.message || String(e) });
        }
      }
      out({ pool: cand.length, promoted, failed, stoppedByDailyCap: stopped || undefined, results: results.slice(0, 10), hint: 'Leads promus member->fsd_profile : deviennent invitables. Lance `invite --segment <X> --geo <Y>`. Cap profile 50/j.' });
      break;
    }
    case 'resolve-pending': {
      const minScore = num(flags['min-score'], 1);
      const limit = num(flags.limit, 10);
      const leads = getLeads()
        .filter((l) => !l.resolved && !l.profileUrl && l.profileUrn && l.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const results: any[] = [];
      for (const l of leads) {
        try {
          const r = await resolveProfileUrl(l.profileUrn!);
          if (r.profileUrl) markResolved(l.profileUrn!, r.profileUrl);
          results.push({ name: l.name, score: l.score, profileUrl: r.profileUrl || null });
        } catch (e: any) {
          results.push({ name: l.name, error: e?.message || String(e) });
          if (e instanceof DailyCapReached) break;
        }
      }
      out({ attempted: leads.length, results, hint: 'URLs écrites dans data/people.jsonl (resolved:true).' });
      break;
    }

    /* ---------- réseau : demandes de connexion ----------
     * `invite <url|urn>...` invite EXACTEMENT ces profils (résolus via le store
     * pour l'URN). Sans argument : puise dans le pool invitable (score décroissant). */
    case 'invite': {
      const targetsArg = _.slice(1);
      const dryRun = !!flags['dry-run'];
      type Cand = { name: string; profileUrn?: string; headline?: string; score?: number; input?: string };
      let pool: Cand[];
      let missing: string[] = [];
      if (targetsArg.length) {
        const resolved = resolveTargets(targetsArg);
        pool = resolved.filter((r) => r.profileUrn).map((r) => ({ name: r.name || r.input, profileUrn: r.profileUrn, headline: r.lead?.headline, score: r.lead?.score, input: r.input }));
        missing = resolved.filter((r) => !r.profileUrn).map((r) => r.input);
      } else {
        const minScore = num(flags['min-score'], 0);
        const group = typeof flags.group === 'string' ? flags.group : undefined;
        const g = geoFrom(flags.geo);
        const target = num(flags.target, 0);
        let inv = getInvitable({ minScore, group, geo: g?.urn, segment: typeof flags.segment === 'string' ? flags.segment : undefined });
        if (target > 0) inv = inv.slice(0, target);
        pool = inv.map((l) => ({ name: l.name, profileUrn: l.profileUrn, headline: l.headline, score: l.score }));
      }
      if (dryRun) {
        out({ dryRun: true, wouldInvite: pool.length, notFound: missing.length ? missing : undefined, sample: pool.slice(0, 10).map((c) => ({ name: c.name, score: c.score, headline: c.headline })), hint: 'Retire --dry-run pour envoyer. Espacement 60-120s + plafond ~20/j appliqués par l\'outil.' });
        break;
      }
      if (!pool.length) {
        out({ pool: 0, sent: 0, notFound: missing, hint: targetsArg.length ? 'Aucune cible résolue en profileUrn. Capture d\'abord le profil via `search-people`.' : 'Aucun lead invitable. Élargis avec `search-people`/`campaign` ou baisse --min-score.' });
        break;
      }
      const since = new Date().toISOString();
      let sent = 0;
      let failed = 0;
      let stopped = false;
      const results: any[] = [];
      for (const c of pool) {
        try {
          const r = await sendInvitation(c.profileUrn!, {}); // sans note
          if (r.ok) {
            markInvited(c.profileUrn!, new Date().toISOString());
            sent++;
            results.push({ name: c.name, status: r.status, sent: true });
          } else {
            failed++;
            // Déjà invité côté serveur (invitation pending) -> marquer pending pour ne plus le re-tenter.
            if (/CANT_RESEND_YET/.test(r.error || '')) markInvited(c.profileUrn!, new Date().toISOString());
            results.push({ name: c.name, status: r.status, error: r.error });
          }
        } catch (e: any) {
          if (e instanceof DailyCapReached) { stopped = true; break; }
          failed++;
          results.push({ name: c.name, error: e?.message || String(e) });
        }
      }
      out({ pool: pool.length, sent, failed, notFound: missing.length ? missing : undefined, stoppedByDailyCap: stopped || undefined, since, results, hint: 'Invitations parties (marquées pending). Laisse le temps aux gens d\'accepter, puis `check-accepted`. Relance demain quand le quota repart.' });
      break;
    }

    /* ---------- réseau : détecter les acceptations ----------
     * On recherche chaque invité en attente via searchPeople (endpoint éprouvé)
     * et on matche par profileUrn EXACT (robuste aux homonymes). Accepté si le
     * résultat est en 1er degré (degree===1). Aucun appel à l'endpoint profil. */
    case 'check-accepted': {
      const targetsArg = _.slice(1);
      const limit = num(flags.limit, 40);
      type Chk = { name: string; profileUrn?: string };
      let batch: Chk[];
      let notFound: string[] = [];
      if (targetsArg.length) {
        const resolved = resolveTargets(targetsArg);
        batch = resolved.filter((r) => r.profileUrn).map((r) => ({ name: r.name || r.input, profileUrn: r.profileUrn }));
        notFound = resolved.filter((r) => !r.profileUrn).map((r) => r.input);
      } else {
        const pending = getPendingInvites();
        if (!pending.length) {
          out({ pending: 0, newlyAccepted: 0, hint: 'Aucune invitation en attente. Envoie-en avec `invite`, ou passe les profils en argument.' });
          break;
        }
        // Rotation : les moins récemment vérifiés d'abord (jamais vérifié en tête), tie-break invitedAt.
        // Évite de rester bloqué sur les plus anciens non-acceptants et couvre tout le pool au fil des tirs.
        pending.sort(
          (a, b) =>
            (a.lastRelCheckAt || '').localeCompare(b.lastRelCheckAt || '') ||
            (a.invitedAt || '').localeCompare(b.invitedAt || ''),
        );
        batch = pending.map((l) => ({ name: l.name, profileUrn: l.profileUrn }));
      }
      batch = batch.slice(0, limit);
      const acceptedUrns: string[] = [];
      const checkedUrns: string[] = [];
      const accepted: string[] = [];
      const stillPending: string[] = [];
      const noRelation: string[] = [];
      const results: any[] = [];
      let checked = 0;
      let stopped = false;
      for (const c of batch) {
        try {
          const rel = await getMemberRelationship(c.profileUrn!);
          checked++;
          checkedUrns.push(c.profileUrn!);
          if (rel.status === 'connected') {
            acceptedUrns.push(c.profileUrn!);
            accepted.push(c.name);
            results.push({ name: c.name, status: 'connected' });
          } else {
            if (rel.status === 'pending') stillPending.push(c.name);
            else noRelation.push(c.name);
            results.push({ name: c.name, status: rel.status, distance: rel.distance ?? null });
          }
        } catch (e: any) {
          if (e instanceof DailyCapReached) { stopped = true; break; }
          results.push({ name: c.name, error: e?.message || String(e) });
        }
      }
      const at = new Date().toISOString();
      const n = markAcceptedMany(acceptedUrns, at);
      markRelCheckedMany(checkedUrns, at); // stampe la rotation (tous les vérifiés, acceptés ou non)
      out({
        checked,
        newlyAccepted: n,
        accepted,
        stillPending,
        noPendingOrDeclined: noRelation,
        notFound: notFound.length ? notFound : undefined,
        stoppedByDailyCap: stopped || undefined,
        results,
        hint: n
          ? 'Acceptés (connected) marqués invite=accepted + degree=1 dans data/people.jsonl. Fais `export`, puis contacte-les !'
          : 'Aucune acceptation sur ce lot. stillPending = invitation encore en attente ; noPendingOrDeclined = ni connecté ni invitation active.',
      });
      break;
    }

    /* ---------- réseau : détecter les RÉPONSES entrantes ----------
     * Pour chaque lead messagé (avec conversationId), lit les events du thread et
     * marque `replied` si un message entrant (expéditeur ≠ soi) est présent. Rotation
     * par lastReplyCheckAt. Les répondants sont ensuite exclus de `followup`. */
    case 'check-replies': {
      const limit = num(flags.limit, 40);
      const batch = getReplyCheckable({ limit });
      if (!batch.length) {
        out({ checked: 0, newlyReplied: 0, hint: 'Aucune conversation à vérifier (messages sans conversationId, ou déjà marqués répondu).' });
        break;
      }
      const repliedIds: string[] = [];
      const repliedTexts: Record<string, string> = {};
      const checkedIds: string[] = [];
      const replied: string[] = [];
      const results: any[] = [];
      let checked = 0;
      let stopped = false;
      for (const l of batch) {
        try {
          const r = await conversationHasReply(l.conversationId!);
          checked++;
          checkedIds.push(l.conversationId!);
          if (r.replied) {
            repliedIds.push(l.conversationId!);
            if (r.text) repliedTexts[l.conversationId!] = r.text;
            replied.push(l.name);
            results.push({ name: l.name, replied: true, incoming: r.incoming, text: r.text });
          } else {
            results.push({ name: l.name, replied: false });
          }
        } catch (e: any) {
          if (e instanceof DailyCapReached) { stopped = true; break; }
          results.push({ name: l.name, error: e?.message || String(e) });
        }
      }
      const at = new Date().toISOString();
      const n = markRepliedMany(repliedIds, at, repliedTexts);
      markReplyCheckedMany(checkedIds, at);
      const prof = getProfile();
      exportLeads({ minScore: prof.minScore || 0, split: true });
      out({
        checked,
        newlyReplied: n,
        replied,
        stoppedByDailyCap: stopped || undefined,
        results,
        hint: n ? 'Répondants marqués (colonne "Répondu ?") — exclus automatiquement du `followup`.' : 'Aucune nouvelle réponse sur ce lot.',
      });
      break;
    }

    /* ---------- réseau : 1er message (message normal si connecté, InMail sinon) ----------
     * Message normal aux relations (1er degré) ; InMail aux non-connectés SI un crédit InMail
     * est dispo. Dès que le serveur signale "plus de crédit InMail", on ARRÊTE l'InMail pour la
     * journée (persisté) mais on continue les messages normaux aux connectés. */
    case 'message': {
      const targetsArg = _.slice(1);
      const dryRun = !!flags['dry-run'];
      let baseText = typeof flags.text === 'string' ? flags.text : '';
      if (!baseText && typeof flags.file === 'string') {
        try { baseText = readFileSync(resolve(flags.file), 'utf8'); }
        catch (e: any) { return fail(`--file illisible: ${e?.message || e}`); }
      }
      const connectedText = (typeof flags['connected-text'] === 'string' ? flags['connected-text'] : '') || baseText;
      const inmailText = (typeof flags['inmail-text'] === 'string' ? flags['inmail-text'] : '') || baseText;
      const subject = typeof flags.subject === 'string' ? flags.subject : undefined;
      // InMail = canal NON vérifié : opt-in explicite via --inmail (sinon on ne contacte que les 1er degré).
      const allowInmail = !!flags.inmail;

      type Cand = { name: string; profileUrn?: string; headline?: string; score?: number; degree?: number; input?: string };
      let pool: Cand[];
      let missing: string[] = [];
      if (targetsArg.length) {
        const resolved = resolveTargets(targetsArg);
        pool = resolved.filter((r) => r.profileUrn).map((r) => ({ name: r.name || r.input, profileUrn: r.profileUrn, headline: r.lead?.headline, score: r.lead?.score, degree: r.lead?.degree, input: r.input }));
        missing = resolved.filter((r) => !r.profileUrn).map((r) => r.input);
      } else {
        const minScore = num(flags['min-score'], 0);
        const group = typeof flags.group === 'string' ? flags.group : undefined;
        const g = geoFrom(flags.geo);
        const target = num(flags.target, 0);
        let cand = getMessageable({ minScore, group, geo: g?.urn, segment: typeof flags.segment === 'string' ? flags.segment : undefined });
        if (target > 0) cand = cand.slice(0, target);
        pool = cand.map((l) => ({ name: l.name, profileUrn: l.profileUrn, headline: l.headline, score: l.score, degree: l.degree }));
      }
      const channelOf = (c: Cand): 'message' | 'inmail' => (c.degree === 1 ? 'message' : 'inmail');
      const connected = pool.filter((c) => channelOf(c) === 'message');
      const nonConnected = pool.filter((c) => channelOf(c) === 'inmail');

      if (dryRun) {
        out({
          dryRun: true,
          pool: pool.length,
          connected: connected.length,
          inmail: nonConnected.length,
          inmailEnabled: allowInmail,
          inmailExhaustedToday: isInmailExhaustedToday() || undefined,
          hasText: { connected: !!connectedText.trim(), inmail: !!inmailText.trim() },
          notFound: missing.length ? missing : undefined,
          sample: pool.slice(0, 10).map((c) => ({ name: c.name, channel: channelOf(c), score: c.score, headline: c.headline })),
          hint: 'Retire --dry-run pour envoyer. Fournis --text "..." (ou --file <path>) ; options --inmail-text / --connected-text / --subject. Sans --inmail, seuls les 1er degré sont contactés (InMail = canal non vérifié, opt-in). Espacement 45-90s + plafond quotidien par l\'outil. Par défaut on saute les gens avec un fil de discussion existant ; --allow-existing force l\'envoi. Placeholders {first_name} {name}.',
        });
        break;
      }

      if (!connectedText.trim() && !inmailText.trim()) {
        return fail('Aucun texte de message. Donne --text "..." (ou --file <path>), et/ou --inmail-text / --connected-text.');
      }
      if (!pool.length) {
        out({ pool: 0, sent: 0, notFound: missing, hint: targetsArg.length ? 'Aucune cible résolue en profileUrn. Capture d\'abord le profil via `search-people`.' : 'Aucun lead à messager. Élargis via `campaign`/`search-people` ou baisse --min-score.' });
        break;
      }

      const render = (tpl: string, c: Cand) =>
        tpl.replace(/\{first_name\}/gi, (c.name || '').split(/\s+/)[0] || '').replace(/\{name\}/gi, c.name || '');
      const since = new Date().toISOString();
      let sent = 0, failed = 0, skippedInmail = 0, inmailSkippedNoFlag = 0, stopped = false;
      let inmailBlocked = isInmailExhaustedToday();
      let inmailFailStreak = 0; // coupe-circuit : endpoint InMail non vérifié -> on n'insiste pas indéfiniment
      const results: any[] = [];

      // Garde-fou : ne JAMAIS écrire un 1er message à froid à quelqu'un avec qui
      // un fil existe déjà (la personne est venue parler d'elle-même, ou historique).
      // On liste une fois les participants des conversations récentes.
      // --allow-existing désactive ce garde-fou (envoie quand même).
      const allowExisting = !!flags['allow-existing'];
      let priorParticipants = new Set<string>();
      let priorLookupOk = true;
      if (!allowExisting) {
        try { priorParticipants = await getRecentConversationParticipants(); }
        catch { priorLookupOk = false; } // inclut un éventuel plafond : on ne crashe pas
      }
      // Sécurité : si on n'a pas pu vérifier les fils existants, on NE PAS envoyer
      // (mieux vaut rater un envoi que d'écrire à froid à quelqu'un avec un historique).
      if (!allowExisting && !priorLookupOk) {
        return fail('Vérif des fils existants indisponible (inbox). Envoi suspendu par sécurité — réessaie plus tard, ou --allow-existing pour forcer.');
      }
      let skippedPrior = 0;

      // Connectés (message normal, canal vérifié) d'abord, puis non-connectés (InMail, opt-in).
      for (const c of [...connected, ...nonConnected]) {
        const channel = channelOf(c);
        const cid = c.profileUrn?.match(/ACoAA[A-Za-z0-9_-]+/)?.[0];
        if (cid && priorParticipants.has(cid)) {
          markPriorConversation(c.profileUrn!);
          skippedPrior++;
          results.push({ name: c.name, channel, skipped: 'fil-existant' });
          continue;
        }
        if (channel === 'inmail') {
          if (!allowInmail) { inmailSkippedNoFlag++; continue; } // InMail désactivé par défaut
          if (inmailBlocked) { skippedInmail++; continue; }
        }
        const tpl = channel === 'inmail' ? inmailText : connectedText;
        if (!tpl.trim()) { results.push({ name: c.name, channel, skipped: 'no-text' }); continue; }
        try {
          const r = await sendMessage(c.profileUrn!, render(tpl, c), { channel, subject });
          if (r.ok) {
            markMessaged(c.profileUrn!, new Date().toISOString(), channel, 'sent', r.conversationId);
            sent++;
            if (channel === 'inmail') inmailFailStreak = 0;
            results.push({ name: c.name, channel, status: r.status, sent: true });
          } else if (r.noInmailCredit) {
            inmailBlocked = true;
            markInmailExhaustedToday();
            results.push({ name: c.name, channel, error: 'plus de crédit InMail — arrêt InMail pour aujourd\'hui' });
          } else {
            failed++;
            markMessaged(c.profileUrn!, new Date().toISOString(), channel, 'failed');
            results.push({ name: c.name, channel, status: r.status, error: r.notAllowed ? 'non joignable (ni relation, ni Open Profile, ni crédit)' : r.error });
            // Coupe-circuit InMail : 3 échecs d'affilée -> stop InMail du jour (plus de crédit ou endpoint KO).
            if (channel === 'inmail' && ++inmailFailStreak >= 3) {
              inmailBlocked = true;
              markInmailExhaustedToday();
              results.push({ channel: 'inmail', note: '3 échecs InMail d\'affilée — arrêt InMail pour aujourd\'hui (endpoint non vérifié / crédit épuisé)' });
            }
          }
        } catch (e: any) {
          if (e instanceof DailyCapReached) { stopped = true; break; }
          failed++;
          results.push({ name: c.name, channel, error: e?.message || String(e) });
        }
      }

      const prof = getProfile();
      exportLeads({ minScore: prof.minScore || 0, split: true }); // rafraîchit les CSV (colonne "Message envoyé ?")
      out({
        pool: pool.length,
        sent,
        failed,
        inmailSkippedNoFlag: inmailSkippedNoFlag || undefined,
        skippedInmail: skippedInmail || undefined,
        skippedPriorConversation: skippedPrior || undefined,
        priorConversationLookupFailed: priorLookupOk ? undefined : true,
        bypassedHistoryGuard: allowExisting || undefined,
        inmailExhaustedToday: inmailBlocked || undefined,
        stoppedByDailyCap: stopped || undefined,
        notFound: missing.length ? missing : undefined,
        since,
        results,
        hint: (inmailSkippedNoFlag ? `${inmailSkippedNoFlag} non-connectés ignorés (ajoute --inmail pour les contacter en InMail). ` : '') + 'Messages partis (voir colonne "Message envoyé ?" dans data/leads*.csv). Relance demain quand le quota/crédit InMail repart.',
      });
      break;
    }

    /* ---------- réseau : relance (follow-up) des acceptés déjà messagés ----------
     * 2e message aux leads en 1er degré déjà messagés, pas encore relancés, dont le 1er
     * message date d'au moins --after-days jours (défaut 3). Canal message normal (vérifié). */
    case 'followup': {
      const targetsArg = _.slice(1);
      const dryRun = !!flags['dry-run'];
      let text = typeof flags.text === 'string' ? flags.text : '';
      if (!text && typeof flags.file === 'string') {
        try { text = readFileSync(resolve(flags.file), 'utf8'); }
        catch (e: any) { return fail(`--file illisible: ${e?.message || e}`); }
      }
      const afterDays = Math.max(3, num(flags['after-days'], 3)); // minimum 3 jours entre 2 relances (imposé)
      const before = new Date(Date.now() - afterDays * 86400000).toISOString();
      // Défaut 1 : il n'y a qu'UN template de relance, donc >1 relance = renvoyer
      // le MÊME DM = spam. Une seule relance par personne.
      const maxFollowups = num(flags['max-followups'], 1);
      const imagePath = typeof flags.image === 'string' ? resolve(flags.image) : undefined;
      if (imagePath && !existsSync(imagePath)) return fail(`--image introuvable: ${imagePath}`);
      type Cand = { name: string; profileUrn?: string; headline?: string; score?: number; conversationId?: string; input?: string };
      let pool: Cand[];
      let missing: string[] = [];
      if (targetsArg.length) {
        const resolved = resolveTargets(targetsArg);
        pool = resolved.filter((r) => r.profileUrn).map((r) => ({ name: r.name || r.input, profileUrn: r.profileUrn, headline: r.lead?.headline, score: r.lead?.score, conversationId: r.lead?.conversationId, input: r.input }));
        missing = resolved.filter((r) => !r.profileUrn).map((r) => r.input);
      } else {
        const minScore = num(flags['min-score'], 0);
        const group = typeof flags.group === 'string' ? flags.group : undefined;
        const g = geoFrom(flags.geo);
        const target = num(flags.target, 0);
        let cand = getFollowupable({ minScore, group, geo: g?.urn, before, maxFollowups, segment: typeof flags.segment === 'string' ? flags.segment : undefined });
        if (target > 0) cand = cand.slice(0, target);
        pool = cand.map((l) => ({ name: l.name, profileUrn: l.profileUrn, headline: l.headline, score: l.score, conversationId: l.conversationId }));
      }
      if (dryRun) {
        out({ dryRun: true, pool: pool.length, afterDays, maxFollowups, hasText: !!text.trim(), hasImage: !!imagePath, withConversation: pool.filter((c) => c.conversationId).length, notFound: missing.length ? missing : undefined, sample: pool.slice(0, 10).map((c) => ({ name: c.name, score: c.score, headline: c.headline })), hint: 'Retire --dry-run pour relancer. --text/--file requis, --image <path> optionnel (PJ). Écart min 3j depuis le dernier contact ; max --max-followups relances (défaut 1 — un seul template, >1 renverrait le même DM). Espacement 45-90s (kind message). Placeholders {first_name}/{name}.' });
        break;
      }
      if (!text.trim()) return fail('Aucun texte de relance. Donne --text "..." ou --file <path>.');
      if (!pool.length) {
        out({ pool: 0, sent: 0, notFound: missing, hint: targetsArg.length ? 'Aucune cible résolue en profileUrn.' : 'Personne à relancer (déjà relancés, pas encore messagés, ou délai --after-days non atteint).' });
        break;
      }
      const render = (tpl: string, c: Cand) =>
        tpl.replace(/\{first_name\}/gi, (c.name || '').split(/\s+/)[0] || '').replace(/\{name\}/gi, c.name || '');
      const since = new Date().toISOString();
      let sent = 0, failed = 0, stopped = false, skippedNotOurs = 0;
      const allowExisting = !!flags['allow-existing']; // bypass : relancer même un fil non initié par nous
      const results: any[] = [];
      for (const c of pool) {
        try {
          // Règle : on ne relance QUE les fils qu'on a INITIÉS (1er message = nous).
          // Sinon on s'incruste dans une conversation organique / un historique.
          if (!allowExisting && c.conversationId && !(await conversationFirstFromSelf(c.conversationId))) {
            markPriorConversation(c.profileUrn!);
            skippedNotOurs++;
            results.push({ name: c.name, skipped: 'fil non initié par nous' });
            continue;
          }
          const r = await sendMessage(c.profileUrn!, render(text, c), { channel: 'message', conversationId: c.conversationId, imagePath });
          if (r.ok) {
            markFollowedUp(c.profileUrn!, new Date().toISOString());
            sent++;
            results.push({ name: c.name, status: r.status, sent: true });
          } else {
            failed++;
            results.push({ name: c.name, status: r.status, error: r.error });
          }
        } catch (e: any) {
          if (e instanceof DailyCapReached) { stopped = true; break; }
          failed++;
          results.push({ name: c.name, error: e?.message || String(e) });
        }
      }
      const prof = getProfile();
      exportLeads({ minScore: prof.minScore || 0, split: true });
      out({ pool: pool.length, sent, failed, skippedNotOurs: skippedNotOurs || undefined, stoppedByDailyCap: stopped || undefined, notFound: missing.length ? missing : undefined, since, results, hint: 'Relances parties (colonne "Follow-up ?" dans data/leads*.csv). Plafond partagé avec `message` (kind message). skippedNotOurs = fils non initiés par nous, exclus.' });
      break;
    }

    /* ---------- (re)scoring, consultation, export ---------- */
    case 'rescore': {
      const n = rescoreAll();
      out({ rescored: n, hint: 'Score + tags recalculés contre le profil actif. Refais `export` ensuite.' });
      break;
    }
    case 'leads': {
      const minScore = num(flags['min-score'], 0);
      const limit = num(flags.limit, 50);
      const group = typeof flags.group === 'string' ? flags.group : undefined;
      let leads = getLeads().filter((l) => l.score >= minScore);
      if (flags.unresolved) leads = leads.filter((l) => !l.profileUrl);
      leads.sort((a, b) => b.score - a.score);
      const top = leads.slice(0, limit).map((l) => ({ name: l.name, score: l.score, tags: l.tags, geo: l.geo || null, headline: l.headline, profileUrl: l.profileUrl || null, profileUrn: l.profileUrl ? undefined : l.profileUrn, source: l.source }));
      out({ totalMatching: leads.length, showing: top.length, group: group || null, leads: top });
      break;
    }
    case 'export': {
      const minScore = num(flags['min-score'], getProfile().minScore || 0);
      const exp = exportLeads({ minScore, split: !flags['no-split'] });
      out({ minScore, combined: exp.combined, groups: exp.groups, connection: exp.connection, note: 'Géo-confirmé priorisé, puis score. Groupes = profil actif. Découpe connecté/non-connecté auto si le degré est connu.' });
      break;
    }

    default:
      out({
        usage: [
          '— session —',
          'seed-cookies [path]   (défaut: ./cookies — export TSV DevTools)',
          'login | whoami | status',
          '— cible (ICP, composée par l\'agent) —',
          'geo "<lieu>"                         -> geoUrn',
          'profile show | reset',
          'profile set [--file <profile.json>] [--icp "..."] [--keywords a,b] [--geo name|urn|--no-geo] [--min-score N] [--rules <json|file>] [--groups <json|file>] [--replace-keywords]',
          '— collecte —',
          'search-people "<kw>" [--geo name|urn] [--start N --count N]',
          'search-posts "<kw>" [--start N --count N --date past-week]',
          'comments <postUrn> [--start N --count N]',
          'campaign [--mode people|posts] [--keywords a,b] [--geo name|urn] [--target N] [--pages N] [--per-page N] [--comments] [--max-comment-posts N] [--min-score N]',
          'resolve <urn|ACoAA...>   |   resolve-pending [--min-score N --limit N]',
          '— réseau (connexions) —',
          'invite [<url|urn>...] [--group X] [--geo name|urn] [--min-score N] [--target N] [--dry-run]  -> connexions (sans note, 60-120s, ~20/j). Args=profils précis, sinon pool.',
          'check-accepted [<url|urn>...] [--limit N]                    -> qui a accepté (args précis, sinon invités pending) — via memberRelationship: connected/pending/none',
          'check-replies [--limit N]                                    -> détecte les réponses entrantes (lit les threads) ; marque "Répondu ?" et exclut du followup',
          'followup [<url|urn>...] [--group X] [--geo name|urn] [--min-score N] [--target N] [--after-days N] [--max-followups N] [--text "..."|--file <p>] [--image <path>] [--dry-run]  -> relance des 1er degré déjà messagés (écart min 3j, PAS répondu, max 2 relances). --image = PJ.',
          'message [<url|urn>...] [--group X] [--geo name|urn] [--min-score N] [--target N] [--text "..."|--file <p>] [--inmail-text ...] [--connected-text ...] [--subject ...] [--inmail] [--dry-run]  -> 1er message: normal aux 1er degré (vérifié) ; --inmail pour InMail aux non-connectés (opt-in, stop dès "plus de crédit"). Placeholders {first_name}/{name}.',
          '— résultats —',
          'rescore   (recalcule score/tags contre le profil)',
          'leads [--min-score N --limit N --group X --unresolved]',
          'export [--min-score N --no-split]   -> data/leads*.csv',
        ],
      });
  }
}

main()
  .catch((e) => {
    if (e instanceof DailyCapReached) {
      process.stderr.write(`⛔ ${e.message}\n`);
      process.exitCode = 2;
    } else if (e instanceof TokenInvalidError) {
      process.stderr.write(`🔑 ${e.message}\n`);
      process.exitCode = 3;
    } else if (e instanceof NotLoggedInError) {
      process.stderr.write(`🔒 ${e.message}\n`);
      process.exitCode = 4;
    } else {
      process.stderr.write(`❌ ${e?.stack || e?.message || String(e)}\n`);
      process.exitCode = 1;
    }
  })
  .finally(async () => {
    await closeBrowser();
  });

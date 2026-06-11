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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  searchPosts,
  searchPeople,
  getComments,
  resolveProfileUrl,
  resolveGeo,
  DateFilter,
} from './voyager/endpoints.js';
import {
  upsertLead,
  appendPost,
  appendComment,
  getLeads,
  getPosts,
  markResolved,
  rescoreAll,
  exportLeads,
} from './store.js';
import { postIsRelevant } from './score.js';
import { getProfile, saveProfile, resetProfile, ScoreRule, Group } from './profile.js';
import { getStatus, DailyCapReached } from './ratelimit.js';
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
        const r = upsertLead(person, [person.headline || ''], { geo: g?.label });
        if (r.isNew) newLeads++;
      }
      out({ query: kw, geo: g?.label || null, peopleFound: page.people.length, newLeads, nextStart: page.nextStart, rawFile: page.rawFile, hint: 'Leads dans data/people.jsonl (commande `leads`).' });
      break;
    }
    case 'comments': {
      const postUrn = _[1];
      if (!postUrn) return fail('Usage: comments <postUrn|activityId> [--start N] [--count N]');
      const known = getPosts().find((p) => p.postUrn === postUrn || p.ugcPostUrn === postUrn || p.socialDetailUrn === postUrn);
      const target = known?.socialDetailUrn || known?.ugcPostUrn || postUrn;
      const page = await getComments(target, { start: num(flags.start, 0), count: num(flags.count, 10), postUrnLabel: known?.postUrn || postUrn });
      let newLeads = 0;
      let relevant = 0;
      for (const c of page.comments) {
        appendComment(c);
        const r = upsertLead(c.author, [c.author.headline || '', c.text.slice(0, 240)]);
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
                const r = upsertLead(person, [person.headline || ''], { geo: g?.label });
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
              const r = upsertLead(c.author, [c.author.headline || '', c.text.slice(0, 240)]);
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

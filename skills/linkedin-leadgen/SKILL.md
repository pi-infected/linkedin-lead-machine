---
name: linkedin-leadgen
description: Generate LinkedIn leads for ANY target. Use when the user wants to find/collect/export LinkedIn people matching a profile — by role, industry, location, or what they post about (e.g. "find DevOps leads in Germany", "marketing agency owners commenting on AI posts", "export my leads to CSV"). The agent builds the ICP, searches people/posts/comments, scores, classifies, and writes CSVs, pacing itself to protect the account.
---

# LinkedIn lead-gen

A generic engine that turns a target description into a CSV of LinkedIn leads. **You
(the agent) own the targeting.** The engine exposes neutral functions — search, collect,
score, classify, export — and you compose them from a conversation with the user. Nothing
is hardcoded to any industry or use case.

Engine entry point: **`${CLAUDE_PLUGIN_ROOT}/bin/lk <command>`** (or `bin/lk` from the repo
root). Network commands run a real browser under `xvfb` automatically; offline commands
(`profile`, `geo`, `leads`, `export`, `rescore`, `status`) run directly.

## Operating principles (non-negotiable)

1. **Results go to files, not context.** Every command prints a compact JSON summary only.
   Detail lives in `data/people.jsonl`, `data/posts.jsonl`, `data/comments.jsonl`, and the
   `data/leads*.csv` exports. Read those in small slices; never dump them wholesale.
2. **The tool paces itself.** A persistent rate limiter (`state/ratelimit.json`) enforces
   min intervals + jitter, honors `429`/`Retry-After`, and applies a daily cap. Calling in
   a tight loop does not speed anything up. A `stoppedByDailyCap` result is expected — stop
   and resume another day.
3. **Qualify without scraping profiles.** Score from headlines + post/comment text only.
   The profile endpoint is heavily watched: use `resolve`/`resolve-pending` sparingly, and
   only to turn a temporary `urn:li:fsd_profile:ACoAA…` into a real `linkedin.com/in/slug`
   for leads you are keeping.
4. **Geo confirmation comes from people-search filters,** not from post/headline text. To
   target a location reliably, set a `--geo` filter (see `geo`).
5. **Ask how many prospects the user wants — up front.** Before launching a campaign, ask
   for a target count (e.g. 50, 500, "as many as possible"). Pass it as `campaign --target N`
   so the run stops once it has collected N — no needless calls, no under-delivering. If the
   user truly wants the maximum, omit `--target` and widen with more keywords/pages instead,
   and tell them the daily cap may bound the total. Never silently pick a size for them.
6. **Segment proactively — anticipate the user's needs, don't wait to be asked.** ALWAYS
   classify and split the output into separate files, even when the user only said "find me
   leads". At minimum, separate **decision-makers** (who buy) from **individual contributors
   / practitioners** (who use or champion) — these are different outreach motions and belong
   in different files. Go further when the ICP implies it: break out **non-prospects** —
   freelancers, agencies, and competitors offering the same service the user sells — into
   their own bucket so the prospect lists stay clean. You design the groups (see below) as
   part of building the ICP; never hand back a single undifferentiated list when a meaningful
   split is obvious.

## Session setup

```
bin/lk whoami                 # is a session live?
bin/lk seed-cookies <path>    # path = DevTools cookie export (TSV/Netscape); must include li_at + JSESSIONID
bin/lk login                  # OR interactive login window (under xvfb)
```
Never echo cookie values back to the user.

## The ICP = the active profile

You translate the user's target into a profile and persist it. The user never writes JSON
or code — **you** compose it.

```
bin/lk profile set \
  --icp "short description of who we want" \
  --keywords "keyword one,keyword two,keyword three" \
  --geo "United States" \           # name from the geo table, or a raw geoUrn; omit / --no-geo for worldwide
  --min-score 1 \
  --rules '<json | path>' \         # OPTIONAL custom scoring (see below)
  --groups '<json | path>'          # OPTIONAL custom classification (see below)
bin/lk profile show
bin/lk profile reset
```

- **Keywords** are merged into the profile across calls (use `--replace-keywords` to overwrite).
- **Scoring**: with no `--rules`, a lead's score = how many campaign keywords its text
  matches (simple, transparent). For finer control, pass rules:
  ```json
  [{"tag":"pain","weight":4,"patterns":["too expensive","over budget","\\bchurn\\b"]},
   {"tag":"role","weight":2,"patterns":["founder","\\bcto\\b","head of"]}]
  ```
  Patterns are case-insensitive regex (literal fallback if invalid). Re-run `bin/lk rescore`
  after changing rules on already-collected leads.
- **Classification groups** split the CSV output. Default = generic role tiers
  (`decision_maker` / `practitioner` / `other`). Override for any domain:
  ```json
  [{"name":"clinician","patterns":["\\bMD\\b","physician","nurse","surgeon"]},
   {"name":"admin","patterns":["administrator","operations","\\bcoo\\b"]}]
  ```
  First matching group wins (so order matters — put exclusion buckets first), unmatched →
  `other`. One CSV per group is written. **Default to designing groups proactively** (per
  principle 6): keep the decision-maker / practitioner split, and add a non-prospect bucket
  (e.g. `freelance_agency`) ordered first whenever the search will surface competitors.

### Resolving a location → geoUrn
```
bin/lk geo "London Area"      # -> { geoUrn, label }
```
The table covers common countries/regions. For anything else, pass a raw `geoUrn` (digits).
You can extract one from a LinkedIn people-search URL filtered by location (`&geoUrn=…`).

## Collecting leads

One-shot campaign (recommended — opens the browser once, paces itself):
```
bin/lk campaign --mode people --pages 3                 # people search across all profile keywords, geo-filtered
bin/lk campaign --mode posts --comments --pages 2       # find relevant posts, harvest their commenters
bin/lk campaign --keywords "a,b" --geo "Canada" --pages 4   # override profile inline
```
`--mode people` gives geo-confirmed leads (best for location targeting). `--mode posts`
finds people by what they write about and (with `--comments`) pulls engaged commenters.

Single steps (for surgical work):
```
bin/lk search-people "<kw>" --geo "United States" --count 10 --start 0
bin/lk search-posts  "<kw>" --date past-week --count 5
bin/lk comments <postUrn> --count 10
bin/lk resolve <urn|ACoAA…>          # vanity URL for one lead
bin/lk resolve-pending --min-score 2 --limit 10
```

## Results

```
bin/lk status                         # quota, profile summary, lead totals
bin/lk leads --min-score 2 --limit 30 # peek at top leads (compact)
bin/lk rescore                        # recompute score/tags after an ICP change
bin/lk export --min-score 1           # write data/leads.csv + data/leads-<group>.csv
```
CSV columns: `name, group, geo, connected, score, tags, headline, profileUrl, source, evidence`.
Geo-confirmed leads sort first, then score. **Connection split is automatic:** when LinkedIn
reports the connection degree (people search does), export also writes `leads-connected.csv`
(1st-degree — the user already knows them, DM directly) and `leads-not-connected.csv` (needs a
connection request / InMail), and every row carries a `connected` yes/no column. This is a
second, orthogonal cut on top of the role groups — no flag needed.

## Typical end-to-end flow

1. `bin/lk whoami` (if no session, `bin/lk seed-cookies <export>` or `bin/lk login`).
2. Discuss the target with the user → propose keywords, geo, scoring, and **groups that
   segment proactively** (decision-makers vs ICs, plus a non-prospect/competitor bucket if
   the search will surface any) — without being asked. **Ask how many prospects they want**
   (principle 5) and carry it into the campaign as `--target N`.
3. `bin/lk profile set …`
4. `bin/lk campaign --mode people --pages 3`
5. Read `data/leads.csv` headers + counts; report per-group files.
6. Offer to widen (more keywords, another geo, posts mode) or resolve top vanity URLs.
   If the daily cap was hit, say so and suggest resuming the next day.

## Maintenance

LinkedIn rotates internal `queryId`s periodically. If searches suddenly return 0 or a
GraphQL error, the IDs in `src/voyager/endpoints.ts` are stale — re-sniff them with the
helpers in `scripts/` and update the constants. Offline tests: `npx tsx src/selftest.ts`.

# linkedin-leadgen — Claude plugin

<p align="center">
  <img src="assets/pixel-title.png" width="480" alt="LinkedIn Lead Machine in pixel art letters"/>
  <br/>
  <img src="assets/pixel-art.png" width="480" alt="Pixel art: a magnet pulling in LinkedIn leads"/>
</p>

Agent-driven LinkedIn lead generation. You describe **who** you want to reach; the agent
searches LinkedIn (people / posts / comments), scores and classifies the results against an
ICP it builds with you, and exports CSVs. A real browser does the requests, the tool paces
itself to protect your account, and results go to files — never dumped into the chat.

There is **nothing hardcoded to any use case**. The engine exposes neutral functions; the
agent composes them from a conversation. The same plugin finds "fintech CTOs in the UK",
"DevOps engineers commenting on Kubernetes posts", or "med-spa owners in Florida".

## Install as a Claude plugin

```
/plugin marketplace add <path-or-git-url-to-this-repo>
/plugin install linkedin-leadgen
```
Then, inside the repo once:
```
npm install
npx patchright install chrome     # or use system Chrome
```

Slash commands:
- `/linkedin-setup` — connect a LinkedIn session (cookies or interactive login)
- `/linkedin-find <who you want>` — the agent builds the ICP, searches, and exports
- `/linkedin-export [min-score]` — (re)export collected leads to CSV

Or just ask in natural language — the **linkedin-leadgen** skill and subagent handle it.

## How it works

- **The ICP is the active profile.** The agent translates your target into keywords, an
  optional geo filter, scoring rules, and classification groups, and persists them with
  `lk profile set`. You never write JSON or code.
- **The tool paces itself, not the agent.** `src/ratelimit.ts` persists the last-call time,
  daily counters, and any server-imposed cooldown on disk (`state/ratelimit.json`). Calling
  in a tight loop just waits. Every `429`/`Retry-After` sets a global cooldown all later
  calls respect. The server is the authority.
- **Results to files, read in slices.** Each command prints a compact JSON summary and
  writes detail to `data/people.jsonl` / `posts.jsonl` / `comments.jsonl` and the
  `data/leads*.csv` exports.
- **Qualify without scraping profiles.** Scoring uses headlines + post/comment text only.
  The profile endpoint is touched sparingly, only to turn a temporary
  `urn:li:fsd_profile:ACoAA…` into a real `linkedin.com/in/slug` for retained leads.

## Transport

Requests go through a **real Chrome driven by patchright** (a stealth Playwright fork),
**headful** on every OS (Cloudflare Turnstile requires it) — a genuine browser fingerprint.
The Voyager `fetch()` calls run *inside* the linkedin.com page (`page.evaluate`); no DOM
scraping.

## Platform support

The cross-platform launcher `bin/lk.mjs` (used by the `lk` command and the `bin/lk` shim)
picks how to supply the display headful Chrome needs:

| OS | How it runs | Requirements |
|---|---|---|
| **Linux** | network commands wrapped in `xvfb-run -a` automatically | `xvfb` installed (`sudo apt-get install -y xvfb`); on a Linux desktop with a screen, set `LK_NO_XVFB=1` to run directly |
| **macOS** | direct, uses the desktop session | Google Chrome installed (Voyager runs in a real window) |
| **Windows** | direct, uses the desktop session | Google Chrome at a standard path (auto-detected), or set `LK_CHROME_PATH` |

Chrome is located via Playwright's `chrome` channel, then standard per-OS install paths,
then patchright's bundled Chromium. Override with `LK_CHROME_PATH=<exe>` or
`LK_BROWSER_CHANNEL=<channel>`. All file I/O is explicit UTF-8. macOS/Windows open a visible
browser window during network commands — that is expected.

Invoke on any OS with `npx lk <cmd>` (after `npm install`), `npm run lk -- <cmd>`, or
`node bin/lk.mjs <cmd>`. On Linux/macOS the `./bin/lk <cmd>` shim also works.

## Quick start (CLI directly)

```bash
npm install
npx patchright install chrome
# paste your cookie jar (DevTools > Application > Cookies, must include li_at) into ./cookies
./bin/lk seed-cookies
./bin/lk whoami                                   # loggedIn: true expected
./bin/lk profile set --icp "fintech CTOs in the UK" \
                     --keywords "fintech CTO,head of engineering fintech,payments engineering lead" \
                     --geo "United Kingdom"
./bin/lk campaign --mode people --pages 3
./bin/lk export                                   # data/leads.csv + data/leads-<group>.csv
```

## Command surface

`bin/lk` — network commands auto-run under xvfb; offline commands run directly.

| Command | What it does |
|---|---|
| `seed-cookies [path]` / `login` / `whoami` / `status` | session + quota/profile state |
| `geo "<place>"` | resolve a location name → geoUrn |
| `profile show \| set … \| reset` | read/compose/clear the active ICP |
| `search-people "<kw>" [--geo …]` | one page of people search |
| `search-posts "<kw>" [--date …]` | one page of post search |
| `comments <postUrn>` | commenters of a post |
| `campaign [--mode people\|posts] [--keywords …] [--geo …] [--pages N] [--comments]` | multi-keyword run, one browser, paced |
| `resolve <urn>` / `resolve-pending` | temporary URN → vanity URL (sparing) |
| `invite [<url\|urn>…] [--target N] [--group X] [--dry-run]` | send connection requests (no note, paced 60-120s, ~20/day cap); args = specific profiles, else the invitable pool |
| `check-accepted [<url\|urn>…] [--limit N]` | who accepted — reliable per-URN relationship check: `connected` / `pending` / `none`; marks accepted leads |
| `rescore` | recompute scores/tags after an ICP change |
| `leads [--min-score N --group X]` | peek at top leads |
| `export [--min-score N --no-split]` | write CSVs (combined + per group) |

## Layout

```
.claude-plugin/   plugin.json + marketplace.json (installable)
commands/         slash commands
agents/           linkedin-leadgen subagent
skills/           linkedin-leadgen SKILL.md (the agent's playbook)
bin/lk.mjs        cross-platform launcher (Linux xvfb / macOS·Windows direct); bin/lk = POSIX shim
src/              the engine (voyager transport, ratelimit, store, profile, score, classify, cli)
data/             leads + raw responses (gitignored)
state/            ratelimit.json + profile.json + browser profile (gitignored)
```

## Maintenance

LinkedIn rotates internal `queryId`s. If searches return 0 or a GraphQL error, the IDs in
`src/voyager/endpoints.ts` are stale — re-sniff with `scripts/` and update them.
Offline tests: `npx tsx src/selftest.ts`. Typecheck: `npm run typecheck`.

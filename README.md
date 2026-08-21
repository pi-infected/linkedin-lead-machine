# linkedin-leadgen — LinkedIn lead-gen & outreach CLI

<p align="center">
  <img src="assets/pixel-title.png" width="480" alt="LinkedIn Lead Machine in pixel art letters"/>
  <br/>
  <img src="assets/pixel-art.png" width="480" alt="Pixel art: a magnet pulling in LinkedIn leads"/>
</p>

Agent-driven LinkedIn lead generation **and outreach**. You describe **who** you want to
reach; the agent searches LinkedIn (people / posts / comments), scores and classifies the
results against an ICP it builds with you, exports CSVs, then — on your go — runs the whole
outreach funnel at a safe pace: **connect → detect acceptance → first message → detect
replies → follow up (with an image), skipping anyone who already answered.** A real browser
does the requests, the tool paces itself to protect your account, and results go to files —
never dumped into the chat.

There is **nothing hardcoded to any use case**. The engine exposes neutral functions; the
agent composes them from a conversation. The same plugin finds "fintech CTOs in the UK",
"DevOps engineers commenting on Kubernetes posts", or "med-spa owners in Florida".

## Install

```
git clone https://github.com/pi-infected/linkedin-lead-machine
cd linkedin-lead-machine
npm install
npx patchright install chrome     # or use system Chrome (auto-detected)
```

Then drive the `lk` CLI directly (see **Quick start** and **Command surface** below). It is a
standalone cross-platform CLI — nothing requires Claude Code. Optionally, an agent can run the
whole flow via the bundled **linkedin-leadgen** skill + subagent (`skills/`, `agents/`).

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
- **Outreach the tool paces for you.** `lk invite` sends connection requests (no note) with a
  60-120s gap and a conservative daily cap, marking each lead `pending`. `lk check-accepted`
  reads each invitee's relationship state by URN (`connected` / `pending` / `none`) — no
  profile scraping, name-independent — and reports the new acceptances.
- **A full messaging funnel, replies-aware.** `lk message` sends the first touch — a normal
  message to 1st-degree connections, or (opt-in `--inmail`) a free InMail to the rest, with a
  credit circuit-breaker that stops for the day once InMail is exhausted. `lk check-replies`
  reads each conversation and marks who answered, capturing their reply text. `lk followup`
  re-touches only the **non-responders**, enforcing a **≥3-day gap** and a max number of
  relances, and can attach an **image**. Message spacing (45-90s) and daily caps are enforced
  in code, not left to the caller. The `data/leads*.csv` exports carry `profileUrl` +
  `Invité ?` / `Accepté ?` / `Message envoyé ?` / `Répondu ?` / `Follow-up ?` columns to
  follow the whole funnel.
- **A/B the target, not the copy.** Every collected lead can be tagged with a `--segment`
  label (`campaign … --segment SCODE`); `invite` / `message` / `followup` filter on it, so one
  pipeline and one set of templates can test which audience actually reacts.

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
./bin/lk invite --target 20                       # send 20 connection requests, self-paced
# ...a few days later...
./bin/lk check-accepted                           # detect who accepted; updates the CSV marks
./bin/lk message --file msg.txt                   # first touch to new 1st-degree connections
# ...a few days later...
./bin/lk check-replies                            # mark who answered (excluded from follow-up)
./bin/lk followup --file relance.txt --image benchmark.jpg   # re-touch non-responders, ≥3-day gap
```

Placeholders `{first_name}` / `{name}` in a message/follow-up file are filled per lead.

## Command surface

`bin/lk` / `lk` — network commands get a headful display automatically (see **Platform
support**); offline commands run directly.

| Command | What it does |
|---|---|
| `seed-cookies [path]` / `login` / `whoami` / `status` | session + quota/profile state |
| `geo "<place>"` | resolve a location name → geoUrn |
| `profile show \| set … \| reset` | read/compose/clear the active ICP |
| `search-people "<kw>" [--geo …]` | one page of people search |
| `search-posts "<kw>" [--date …]` | one page of post search |
| `comments <postUrn>` | commenters of a post |
| `campaign [--mode people\|posts] [--keywords …] [--geo …] [--pages N] [--comments] [--segment X]` | multi-keyword run, one browser, paced; `--segment` tags every lead it collects |
| `resolve <urn>` / `resolve-pending` | temporary URN → vanity URL (sparing) |
| `invite [<url\|urn>…] [--target N] [--group X] [--segment X] [--min-score N] [--dry-run]` | send connection requests (no note, paced 60-120s, ~20/day cap); args = specific profiles, else the invitable pool |
| `check-accepted [<url\|urn>…] [--limit N]` | who accepted — reliable per-URN relationship check: `connected` / `pending` / `none`; marks accepted leads |
| `message [<url\|urn>…] [--file <path> \| --text …] [--inmail] [--connected-text …] [--inmail-text …] [--subject …] [--segment X] [--min-score N] [--dry-run]` | first touch: normal message to 1st-degree; `--inmail` opt-in for InMail to the rest (unverified channel, credit circuit-breaker). Paced 45-90s + daily cap |
| `check-replies [--limit N]` | detect inbound replies per conversation, capture the text, mark `Répondu ?`; responders are excluded from `followup` |
| `followup [<url\|urn>…] [--file <path> \| --text …] [--image <path>] [--after-days N] [--max-followups N] [--segment X] [--min-score N] [--dry-run]` | re-touch non-responders only; enforced ≥3-day gap, **max 1 relance by default** (a single template — more would re-send the same DM), optional image attachment; shares the message daily cap |
| `resolve-members [--segment X] [--min-score N] [--limit N]` | promote commenter leads from `urn:li:member:NNNN` to their invitable `fsd_profile` URN (via a vanity `q=memberIdentity` lookup), so people harvested from post `comments` can be invited; uses the `profile` bucket (cap 50/day) |
| `semantic-rescore [--segment X] [--sim-floor F] [--sim-gain G] [--sim-cap C]` | blend a semantic-similarity bonus into each lead's score — credits the pain expressed in a lead's headline + evidence (e.g. a comment about token cost), not just keyword hits. Offline (no LinkedIn calls); needs the Python bridge below |
| `rescore` | recompute scores/tags after an ICP change |
| `leads [--min-score N --group X]` | peek at top leads |
| `export [--min-score N --no-split]` | write CSVs (combined + per group) |

## Intent-based leads (comments) + semantic scoring

Beyond role/keyword search, you can target people by **intent** — those who commented on
posts about a pain your product solves. Collect them with `comments <postUrn>` (or
`campaign --mode posts --comments`), which now tags each commenter with your `--segment` /
`--geo`. Two follow-ups make them usable:

- `semantic-rescore` credits the pain expressed in their comment (not just their headline),
  so a genuine sufferer outscores a generic title. Competitors — who use the *same*
  vocabulary — are kept out of outreach by the `concurrent` classifier group (never invited,
  messaged, or followed up).
- `resolve-members` turns the `urn:li:member:NNNN` a comment carries into an invitable
  `fsd_profile` URN (paced, 50/day).

**Conversation-history guard.** `message` never cold-messages someone you already have a
recent thread with (they reached out first, or prior history), and `followup` only re-touches
threads whose first message was yours — so the tool never barges into an organic conversation.
Pass `--allow-existing` to override and send anyway. Coverage is the ~20 most-recent
conversations (LinkedIn's inbox doesn't paginate reliably), which catches active threads.

**Semantic scoring needs a small Python bridge** (`scripts/semantic_score.py`): Python 3 +
`pip install -r scripts/requirements.txt` (model2vec + numpy). The static embedding model is
pulled from Hugging Face on first use and cached locally. Everything runs on your machine; no
text leaves it except the one-time model download. If Python or the package is missing,
`semantic-rescore` fails cleanly and the rest of the CLI is unaffected.

## Layout

```
agents/           linkedin-leadgen subagent (optional — lets an agent drive the CLI)
skills/           linkedin-leadgen SKILL.md (optional — the agent's playbook)
bin/lk.mjs        cross-platform launcher (Linux xvfb / macOS·Windows direct); bin/lk = POSIX shim
src/              the engine (voyager transport, ratelimit, store, profile, score, classify, cli)
scripts/          queryId sniffers + semantic_score.py (potion embedding bridge)
data/             leads + raw responses (gitignored)
state/            ratelimit.json + profile.json + browser profile (gitignored)
```

## Maintenance

LinkedIn rotates internal `queryId`s. If searches return 0 or a GraphQL error, the IDs in
`src/voyager/endpoints.ts` are stale — re-sniff with `scripts/` and update them.
Adversarial tests: `npm test`. Offline smoke: `npx tsx src/selftest.ts`. Typecheck: `npm run typecheck`.

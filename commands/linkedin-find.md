---
description: Find LinkedIn leads for a target you describe. The agent builds the ICP, searches, scores, and exports CSVs.
argument-hint: [who you want to reach, e.g. "fintech CTOs in the UK"]
allowed-tools: Bash, Read, AskUserQuestion
---

The user wants to find LinkedIn leads for: **$ARGUMENTS**

Drive this end-to-end using the **linkedin-leadgen** skill. The engine exposes generic
functions; YOU compose them. Nothing is hardcoded to any use case — you build the ICP.

Engine entry point: `${CLAUDE_PLUGIN_ROOT}/bin/lk`

Workflow:
1. **Confirm the session** is live: `${CLAUDE_PLUGIN_ROOT}/bin/lk whoami` (if not, tell the user to run `/linkedin-setup`).
2. **Build the ICP with the user.** From their description, propose: search keywords, an optional location filter, what counts as a "good" lead (scoring), and how to split the output (classification groups). Ask focused questions only where it genuinely changes the search. Then write it to the active profile:
   `${CLAUDE_PLUGIN_ROOT}/bin/lk profile set --icp "..." --keywords "kw1,kw2,..." [--geo "<location>"] [--min-score N] [--rules '<json>'] [--groups '<json>']`
3. **Run the campaign:** `${CLAUDE_PLUGIN_ROOT}/bin/lk campaign --mode people --pages 3` (or `--mode posts --comments` to harvest commenters of relevant posts).
4. **Read results from files**, not context: inspect `data/leads.csv` and the per-group `data/leads-*.csv`. Report counts per group and where the CSVs are.
5. Offer to widen (more keywords / another location / posts mode) or to resolve vanity URLs for top leads.

Respect the rate limiter — it self-paces; re-running fast does not help and the daily cap stops cleanly.

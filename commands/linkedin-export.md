---
description: Export the currently collected LinkedIn leads to CSV (combined + one file per classification group).
argument-hint: [optional minimum score, e.g. 3]
allowed-tools: Bash, Read
---

Export the collected leads to CSV.

Engine entry point: `${CLAUDE_PLUGIN_ROOT}/bin/lk`

1. If the ICP changed since collection, rescore first: `${CLAUDE_PLUGIN_ROOT}/bin/lk rescore`
2. Export: `${CLAUDE_PLUGIN_ROOT}/bin/lk export${ARGUMENTS:+ --min-score $ARGUMENTS}`
   - Writes `data/leads.csv` (combined) and `data/leads-<group>.csv` per classification group from the active profile.
   - Geo-confirmed leads are prioritized, then score.
3. Report the file paths and the row count per group. Read the CSV headers from `data/leads.csv` if the user wants a preview, but do not dump the whole file into the conversation.

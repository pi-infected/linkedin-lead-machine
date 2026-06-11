---
description: Connect a LinkedIn session for the lead-gen plugin (cookies or interactive login) and verify it.
allowed-tools: Bash, Read
---

Set up the LinkedIn session so the lead-gen engine can make requests.

Engine entry point: `${CLAUDE_PLUGIN_ROOT}/bin/lk` (runs network commands under xvfb automatically).

Follow the **linkedin-leadgen** skill's "Session setup" section. In short:

1. Check for an existing session: `${CLAUDE_PLUGIN_ROOT}/bin/lk whoami`
2. If not logged in, ask the user how they want to authenticate:
   - **Cookies (fast):** they paste a DevTools cookie export into a file (must contain `li_at` + `JSESSIONID`), then `${CLAUDE_PLUGIN_ROOT}/bin/lk seed-cookies <path>`.
   - **Interactive login:** `${CLAUDE_PLUGIN_ROOT}/bin/lk login` (a real browser window opens under xvfb).
3. Confirm with `whoami` again and report the result.

Do NOT proceed to searches until `whoami` reports a live session. Never print cookie values back to the user.

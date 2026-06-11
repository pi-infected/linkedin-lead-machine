# Project rules for AI coding agents

Auto-scaffolded by tokenade on first MCP session. Safe to edit; the tokenade block below is identified by the HTML marker and will be updated in-place on future tokenade upgrades.

<!-- tokenade-scaffold -->
## Tokenade rules (v4)

- **Default to tokenade MCP tools** for codebase questions: `mcp__tokenade__semantic_search` for natural-language queries, `symbol_find` for known identifiers, `structure_map` for repo overview, `skeleton` for large files, `call_hierarchy` for "who calls X / what does Y call". Fall back to `grep` / `find` / whole-file `Read` only when the query doesn't fit a structured shape.
- **Subagents you spawn** also need these tools. The Claude Code hook auto-injects a tokenade preamble into every `Task`/`Agent` prompt, so spawned subagents inherit the preference without you having to remember.
- **Fix root causes, not symptoms.** Before patching a visible failure, write the one-sentence answer to "what mechanism produced this, and is my patch addressing the mechanism or the artifact?" Only paper over an artifact when the real fix is out of scope, and say so explicitly.
- For noisy shell commands, route through `tokenade wrap '<cmd>'` — the PreToolUse Bash hook does this automatically when installed.
- **Never prefix commands with `TOKENADE_HOOK_DISABLED=1` pre-emptively.** The hook already passes interactive/TTY commands (ssh, docker exec -it, kubectl attach, vim, …) through untouched, and it never breaks exit codes or stderr-on-failure. Bypassed commands are measured and shown as LOST savings on the dashboard.
- **When a compactor folded bytes you need verbatim** (exact JSON, exact diff, single error line lost to dedup): recover them instantly via `mcp__tokenade__expand_ref` with the `hash=…` printed in the compactor's banner — no re-execution, no re-cost. Only fall back to `tokenade raw <cmd>` (aliases: `bypass`, `noproxy`) when you actually need to re-run a command WITHOUT compaction (e.g., to capture stderr that auto-compact dropped on the floor).
- **Web research goes through tokenade too**: `mcp__tokenade__web_html_to_markdown` to read a page (HTML → compact markdown) and `mcp__tokenade__serp_compact` to fold a search-results page — both are much cheaper than pasting raw HTML or full WebFetch output into context.
- **In reasoning/thinking blocks, be terse.** Write compressed notes, not prose. Omit filler; think in telegrams.
- **Language matching.** Always respond and reason in the same language as the user's message. If the user writes in French, reply in French; in English, in English.
<!-- /tokenade-scaffold -->

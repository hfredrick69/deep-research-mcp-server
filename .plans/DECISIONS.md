# Decisions

## 2026-10-29 — Gemini Deep Research agent plan: review cycle closed at round 3 (REVISE, treated as APPROVE-with-notes)

Plan: `.plans/2026-10-29-gemini-deep-research-agent.md` (Codex-authored, Fable-reviewed via
`codex-fable-review --phase plan`). Rounds 1–3 all REVISE; records under
`.plans/.codex-review/reviews/`. Policy cap is 3 rounds, so no fourth round was run.

**Why the cycle is treated as settled:** every round-3 finding concerns authority text,
sequencing, the live harness, or record-keeping. None concerns the change itself. The
Proportionality rule in Herbert's global instructions counts such a round as
APPROVE-with-notes; the reviewer itself wrote that neither required change needs another
review round. All seven round-3 notes were applied to the plan (Review findings, Round 3).

**Open objections carried to Herbert (no mechanical APPROVE token exists):**
1. Commit scope. The tracked `src/deep-research.ts` imports the untracked June file
   `src/ai/openai-deep-research.ts`, so this change cannot be committed on its own without
   either sweeping in June work or producing a tree that does not build. Options: (a) leave
   the working tree uncommitted for Herbert; (b) commit the June leftover work first as its
   own commit, then this change. Rebuttal to "just commit": neither is the implementing
   session's call. **Decision: Herbert's, pending.**
2. Any commit needs `PLAN_REVIEW_OVERRIDE="<reason>" git commit …` because the plan gate has
   no `approved.json` token after round 3. **Needs Herbert's explicit, logged OK.**

**Fixed verification gaps recorded:** production `GEMINI_API_KEY` (Claude Code config) not
compared with `.env.local` (no secret value is read); Claude Code's own tool-timeout
behaviour unverified until the First Claude Code run, which Herbert starts (second paid run).

Implementation proceeds under the plan; nothing is committed until Herbert decides items 1–2.

## 2026-10-29 — verification record and go-live state

**Verification (plan §Verification):** new tests 79/79; full suite 83 tests, 81 pass, 2 fail —
the two inherited `RecursiveCharacterTextSplitter` failures ("Should handle special characters
and large texts", "Should handle chunkSize equal to chunkOverlap"), identical to the pre-change
baseline. `tsc --noEmit` clean, `git diff --check` clean, scratch `tsc --outDir` compile clean.
Node 20 is not installed on this Mac, so the engines-version check was skipped (not downloaded).
`npm run build` rebuilt `dist/` (baseline copy kept in the session scratch dir). Credential-free
stdio startup check (empty `GEMINI_API_KEY`/`OPENAI_API_KEY`, `RESEARCH_PROVIDER=not-a-provider`)
passed: initialize, tools/list and `mcp://capabilities` all answered, capabilities reported
`provider: invalid` with one problem that does not echo the bad value, stdout carried only
JSON-RPC, no research call was made.

**Live acceptance run (authorized by Herbert for this session):** attempt 1 inside the Bash
sandbox failed in 9 ms with DNS `ENOTFOUND` before any request left the machine (no interaction
created, no charge). Attempt 2 ran outside the sandbox: standard tier, depth 1 / breadth 1,
interaction `v1_ChdCcVhqYW9fRkRvZXZ3YlVQaW9pX3VRURIXQnFYamFvX0ZEb2V2d2JVUGlvaV91UVE`, outcome
`completed`, agent `deep-research-preview-04-2026`, 369 s, 33 GETs, 0 retries, 259 url_citation
annotations, 58 visited URLs, 36 strictly increasing progress notifications, returned text equals
the written `deep_research_report_2026-10-29T20-03-03-043Z.md` (in scratch, outside the repo),
no client errors, stdout clean. The `.env.local` provider line was then flipped
`openai -> gemini` with backup and post-checks (line count and permissions unchanged).

**Gaps:** production `GEMINI_API_KEY` in the Claude Code config was not compared with
`.env.local` (no secret value read). The debug summary line carries no usage/"consumed" field,
so token/cost consumption was not verified from logs. The deep-research MCP server running in
the implementing Claude Code session still uses the old `dist/`; a Claude Code restart picks up
the new build.

**Follow-up (Herbert starts it, second paid run):** First Claude Code run of
`deepResearch.run` after restart; record interaction id, elapsed and outcome here. If Claude
Code cancels the call before completion, roll `.env.local` back to `RESEARCH_PROVIDER=gemini-legacy`.

**Touched files (uncommitted):** modified `.env.example`, `.gitignore`, `CHANGELOG.md`,
`docs/rules/mcp-server-rules.md`, `package.json`, `package-lock.json`, `src/deep-research.ts`,
`src/logger.ts`, `src/mcp-server.ts`; new `src/server.ts`, `src/server.test.ts`,
`src/ai/gemini-deep-research.ts`, `src/ai/gemini-deep-research.test.ts`, `src/deep-research.test.ts`,
`.plans/`. Outside the repo: RESEARCH lane updated identically in
`~/.claude/playbooks/capacity-routing.md` and `~/.codex/AGENTS.md`.

## 2026-10-29 — deep security review recorded
`reports/security/review-2026-10-29.md`: verdict PASS for the change (no High/Critical introduced
or unresolved). 14 findings: F1/F2/F4/F7/F8/F9 Medium pre-existing (HTTP-mode or legacy path, off
locally); F10 Medium on the new `persist_failed` path; F3/F5/F6/F11-F14 Low. Gate token NOT
recorded — nothing is staged until Herbert picks the commit scope; `security-gate.sh approve` runs
after staging. Follow-ups: lane-sized F10+F12 fix; dependency-only change (MCP SDK ≥1.31.1, zod 4,
`npm audit fix`, prune legacy stack, `engines.node`); HTTP-mode hardening bundle (F1,F7,F8,F9).
2026-10-29 plan: stdio large-report handling — Codex-authored .plans/2026-10-29-stdio-large-report.md, Claude-reviewed over 3 rounds (REVISE, APPROVE, APPROVE-with-notes); 20 findings reconciled in the plan. Item 18 decided by Herbert the same day: F10 prerequisite stays lane-sized, REPORT_DIR deferred. Not implemented; gate token rebound 2026-10-29T23:25:45Z after the plan's final edit.
2026-10-29 small-change lane (step 0 of .plans/2026-10-29-stdio-large-report.md): report write failures discarded paid report text (Gemini threw `persist_failed`, legacy/OpenAI threw the raw fs error) and the Gemini runner forwarded an unvalidated upstream status/id into the first progress tick → shared `persistReport()` returns `content` + `persistWarning` and no `reportPath` in all three writers, the default writer uses `flag: 'wx'` (never overwrites), exported `resolveReportDirectory(env, launchCwd)` returns the resolved launch cwd (`REPORT_DIR` deferred, item 18); Gemini create rejects ids outside `/^[A-Za-z0-9_.-]{1,256}$/` as `protocol` and sanitises unknown statuses to `unknown` before progress. Production diff exceeds the lane's 50-line budget (67 added lines in 2 files) because the approved plan requires the shared resolver; covered as execution of that approved plan. Live run of the affected path not performed (paid call, not authorised). (SHA: 0bd9fbc)
2026-10-29 feature (steps 1-4 of .plans/2026-10-29-stdio-large-report.md, executing the approved plan): stdio responses whose text exceeds `MCP_STDIO_INLINE_MAX_BYTES` (default 32768 UTF-8 bytes; `0` forces file mode; invalid values fail with `invalid_config`) return a compact file envelope (absolute report path, byte size, counts, provider/agent, elapsed, heading excerpt, `metadataTruncated` when arrays are dropped) instead of the inline report; the runner's `reportPath` is trusted only when absolute, directly inside `resolveReportDirectory(env, cwd)` and verified via fstat as a regular file of the expected size, otherwise the full report is returned inline with a visible warning; cache key gains format version/transport/limit/directory and file-mode hits are revalidated (invalid → evict, `persist_failed`, not rerun); classified errors carry `isError: true` on both transports; tokenless stdio clients get `notifications/message` progress (starting, 30 s heartbeat, terminal) with `logging/setLevel` honoured, token clients get `notifications/progress`, HTTP tokenless stays silent. HTTP delivery unchanged. README/rules/CHANGELOG/.env.example rewritten to Azure Blob + byte-limit facts. 117 tests (115 pass, 2 inherited text-splitter failures), tsc clean, offline stdio smoke green; live paid run not performed. Post-review hardening folded in: inspectReportFile lstat-first + O_NOFOLLOW|O_NONBLOCK with symlink/FIFO tests; AZURE_CLIENT_SECRET scrubbed. Security report reports/security/review-2026-10-29-stdio-envelope.md (PASS; Lows accepted with rationale). (SHA: fill in after commit)

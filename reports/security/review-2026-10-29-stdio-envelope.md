# Deep Security Review — 2026-10-29 (UTC), third review: stdio large-report envelope

**Change under review:** steps 1-4 of the approved plan `.plans/2026-10-29-stdio-large-report.md`
(APPROVED 2026-10-29T23:25:45Z, rounds=1). Staged diff: 8 files (7 modified + this report),
2120+/209−; production code `src/server.ts` (+908 net incl. a rewrite of the tool handler);
tests `src/server.test.ts`; docs `README.md`, `CHANGELOG.md`, `docs/rules/mcp-server-rules.md`,
`.env.example`; `.plans/DECISIONS.md`.
**Reviewers:** Claude Fable 5.1 (in-session static read + scans) and an independent in-session
review agent given the diff and `src/deep-research.ts` read-only (no secret files opened).
Not a merge commit; `merge-scope.sh` not applicable.
**Dependencies, infra, config:** unchanged (`package.json`/`package-lock.json` not in the diff; no
CI workflows, no infra in the repo).

## Executive summary

**Verdict: PASS.** No High or Critical finding is introduced by, or unresolved in, the staged
change. Both reviews agree. The change adds, for stdio transport only:

- A UTF-8 byte limit `MCP_STDIO_INLINE_MAX_BYTES` (default 32768; `^\d+$` + safe-integer parse,
  otherwise `invalid_config` without echoing the value, `src/server.ts:154-166`). Reports above it
  are returned as a compact file envelope (≤16 KiB, `:68`) carrying the absolute report path,
  excerpt, headings and metadata, never the body.
- Artifact validation before any path is handed to the client: absolute, no control characters,
  `path.dirname(reportPath) === path.resolve(launchCwd)`, lstat+no-follow open+fstat regular file,
  size equal to the in-memory report (`src/server.ts:460-476, 517-570`). Anything else falls back
  to inline delivery with a visible warning; nothing is read from disk when the runner supplied
  text.
- Cache keyed on format version, transport, limit, directory, provider, agent and query inputs;
  file-mode hits revalidated and evicted with `persist_failed`; errors never cached.
- Progress forwarding: `notifications/progress` when the client sends a token, otherwise
  `notifications/message` on stdio with fixed text (requestId, stage, elapsedMs; never the query);
  `logging/setLevel` honoured via the SDK-validated enum; one send in flight, 30 s heartbeat,
  timers `unref`'d and disposed in `finally`.
- Error envelopes now carry `isError: true` on both transports; HTTP additionally stops logging
  the SAS URL and skips the upload after cancellation.

Two of the independent reviewer's findings were fixed in this diff before approval (L1, I1).
The remaining Lows are accepted with rationale below and are not blocking. The dependency audit
(F2) is unchanged from the previous two reports today.

## Findings

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| F2 | Medium (pre-existing) | 66 npm advisories (2 critical, 28 high, 24 moderate, 12 low), transitive | Unchanged; dependency-only change recommended; out of this change's scope |
| L1 | Low | `inspectReportFile` opened the path before checking its type (followed symlinks; a FIFO would block the event loop) | **Fixed in this diff**: lstat first, `O_NOFOLLOW|O_NONBLOCK` open, dev/ino match; tests for symlink and FIFO |
| L2 | Low | TOCTOU between inspection and the by-path read on the no-inline-text branch (`:552`) and HTTP (`:1003`) | Accepted: unreachable, all three runners always set `content`; attacker needs cwd write access |
| L3 | Low | File-mode revalidation compares size only, not content | Accepted: an attacker with cwd write access can already plant any file the client may read; stdio client is local |
| L4 | Low | Inline fallback is unbounded when the file is unusable | Accepted by design (documented in README "Report Delivery"): losing the report is worse than a large stdio message |
| I1 | Info | `AZURE_CLIENT_SECRET` not in the scrub list for the HTTP upload error log | **Fixed in this diff** (`src/server.ts:258`) |
| I2 | Info | Pre-existing: OpenAI runner logs the raw query to stderr (`src/deep-research.ts:238`) | Out of diff; stderr-only, local; note for a later cleanup |
| I3 | Info | Heading regex quadratic on a pathological whitespace run, upstream-model input only | Accepted: bounded by the model's own output, headings capped at 5 × 120 B |
| I4 | Info | Terminal progress notification may be dropped if a heartbeat send is in flight | Accepted: cosmetic; result still returns normally |
| I5 | Info | `metadata.reportPath` on cached inline results may go stale | Accepted: the text is complete; path is a hint only |
| I6 | Info | Pre-existing: cache TTL read once per process | Accepted: key includes transport/dir/limit so no cross-config serving |

### F2 — Dependency advisories (Medium overall, pre-existing)
`npm audit --audit-level=moderate` in the repo root: 66 vulnerabilities (12 low, 24 moderate,
28 high, 2 critical: `fast-xml-parser`, `proxy-addr`; high include `@modelcontextprotocol/sdk`,
`axios`, `body-parser`, `form-data`, `exa-js`, `zod`, `lodash`). Identical to the two earlier
reports today. None are reachable in the shipped stdio configuration (no HTTP listener, no
Azure upload). Dependency changes are explicitly out of scope for this change by standing
instruction; a dependency-only change remains recommended.

### L1 — Inspector followed symlinks and could block on a FIFO (Low, fixed)
Before: `fs.openSync(path, 'r')` then `fstat` (`O_RDONLY` follows symlinks and blocks on a FIFO).
Exploit required write access to the launch directory after the runner's `wx` write. After:
`lstatSync` rejects anything but a regular file before opening; the open uses
`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`; `fstat` must agree on `dev`/`ino` and `isFile()`
(`src/server.ts:460-476`). Tests: symlink to a regular file and a `mkfifo` pipe both return
`not_a_file` (`src/server.test.ts`, "inspectReportFile distinguishes …").

### L2 — By-path read after inspection (Low, accepted)
`src/server.ts:552` reads the file by path only when the runner returned no `content`; every
runner sets `content` (`src/deep-research.ts:208, 236, 328`), so the branch is a defensive
fallback. The HTTP branch (`:1003`) is pre-existing behaviour. Both need an attacker who can
write to the launch directory, who could already plant files. Recommend routing the read
through the inspected descriptor if the fallback is ever made reachable.

### L3 / L4 — Size-only revalidation; unbounded inline fallback (Low, accepted)
Documented trade-offs. The envelope is explicitly a hint to a local client to read a local file;
the server does not and cannot attest file contents for a path the client itself controls.
Inline recovery is the plan's chosen behaviour for persistence failure (README "Report
Delivery").

## Controls verified (both reviewers)
- Path containment and type checks as above; `dirname` strict equality rejects `..`, `.`,
  trailing-slash and case variants (tests "recovers inline …").
- No disk read when inline text exists; size-equality enforced (`:562`).
- Runner writes `flag: 'wx'` (`src/deep-research.ts:94`): never writes through a pre-planted entry.
- Rejected limit value never echoed (`:159`); regex ASCII-only; safe-integer bound; `0` forces file
  mode.
- Error envelopes carry category, interaction id and static note only; upstream text goes to the
  scrubbed stderr log. `scrubSecrets` now covers Gemini, OpenAI, MCP and Azure client secrets.
- Envelope bounded: 16 KiB compact cap with array-dropping fallback and `metadataTruncated`
  note; excerpt 1200 B; 5 headings × 120 B; agent label 128 B; requestId 128 B; path escaped via
  `JSON.stringify`.
- Timers `unref`'d; stopped on finish, dispose and send failure; `dispose()` in `finally`; abort
  listener removed in `finally`.
- Notification rate: one in-flight send, no queue; a rejected send disables forwarding.
- Cancellation: pre-run abort short-circuits; HTTP upload skipped when aborted; post-resolve
  abort caches only `resolvedBeforeAbort && cacheable` and sends no terminal notification.
- Cache: errors never set; file entries only with a verified path; revalidated on hit; bounded 50.
- `logging/setLevel`: SDK parses `SetLevelRequestSchema` before the handler; capability declared
  on stdio only; HTTP tokenless progress is silent.
- All pino output to stderr; stdout carries JSON-RPC only (offline smoke test).
- Absolute paths never returned over HTTP (test pins it).

## Verification record
| Check | Method | Result |
|-------|--------|--------|
| Unit/integration tests | `npm test` (tsx, node:test) | 117 tests, 115 pass, 2 fail: the same two pre-existing `src/ai/text-splitter.test.ts` failures, unrelated to this change |
| Build | `npm run build` | exit 0 |
| Type check | `npx tsc --noEmit -p .` | exit 0 |
| Offline stdio smoke | `node --import tsx --test --test-name-pattern='offline stdio smoke' src/server.test.ts` | 1/1 pass (real stdio child, stub runner, file envelope + inline paths, clean stdout) |
| Whitespace | `git diff --check` | clean |
| Secrets in diff | regex scan (Google/OpenAI key shapes, PEM headers) over the full diff | 0 hits; tests use `dummy-*-0123456789` keys only |
| Secret files | `.env.local`, `gemini_keys.json` | mode 0600, gitignored, not opened, not in diff |
| JS dependencies | `npm audit --audit-level=moderate` (only `./package.json`) | 66 advisories, pre-existing (F2) |
| Python dependencies | `pip-audit` | not run: no `requirements*.txt` / `pyproject.toml` in the repo |
| CI / infra | repo inspection | no `.github/workflows`, no IaC; nothing to review |
| Live checks | — | no HTTP server deployed from this change; stdio exercised offline only. No paid Gemini live run performed (not authorized) |
| Merge scope | — | not a merge commit |
| Independent read | in-session review agent, read-only | 0 High/Medium, 4 Low, 7 Info (reconciled above) |

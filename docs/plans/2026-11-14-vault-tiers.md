---
status: in-flight
next: "Task 2 tiers → Task 3 deps → Task 4 docs → Task 5 review, ready"
branch: cam-723-vault-tiers-make-the-vault-mcp-server-enforce-an
pr: cameronsjo/obaass#35
updated: 2026-11-14
approved_session_id: 32707994-77f2-44ea-9d37-595c7498e1fa
date: 2026-11-14
session_id: 32707994-77f2-44ea-9d37-595c7498e1fa
model: claude-opus-5-5
harness: claude-code 2.1.325
machine: cf6e768835c7
---

# vault-tiers: per-credential access tiers for the vault MCP server

Linear: CAM-723 (parent CAM-719, relay CAM-720).

## Goal

The MCP server maps each bearer token to an access tier and enforces that tier itself. A `limited` token can read and search the vault, and create and append notes in the folders the operator allows, and nothing else. The existing `MCP_AUTH_TOKEN` keeps `full`. No write and no read leaves the vault root under any tier. A release image carries the change on a patched Node base image.

## Decisions for Cameron

- **D1 — where `limited` may write: anywhere in the vault (Cameron, 2026-11-14, in session).** Create and append any `.md` outside dot folders; the agent-instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, any depth, case-insensitive) and the configured daily-note template are refused. Cameron accepted the residual that a `limited` note can carry `dataviewjs` or Templater code, including an append to a template file. The folder allowlist (`MCP_LIMITED_WRITE_DIRS`) was offered and declined.
- **D2 — the unauthenticated mode: narrowed (Cameron, 2026-11-14, in session).** Narrow `MCP_ALLOW_UNAUTHENTICATED=true` from "every `readOnly` tool" to an explicit `anonymous` allowlist (the `limited` read set, same path policy). Today it serves `backup_show_file`, the plugin reads, and dot paths, so a caller with no credential reads more than the `limited` token. Alternative: leave it unchanged and record the inversion. D2 changes what an existing opt-out deployment serves, so it is Cameron's call.

The tasks below implement both answers.

## Loop

| Thing created | Opened by (surfaces) | Closed by (surfaces) | Who closes |
|---|---|---|---|
| A `limited` credential accepted by the server | Operator sets `MCP_AUTH_TOKEN_LIMITED` at deploy (env) | existing — unset or replace the env var and restart; procedure in `docs/runbooks/rotate-mcp-tokens.md` (Task 4) | the operator |

## Workarounds

2 workarounds, 0 on platforms the operator owns. Highest owned: none. Approval files 0 issues.

| Workaround | Limit, checked by | Owner | Kept | Fixed | Route |
|---|---|---|---|---|---|
| Containment walks each existing path component with `lstat` + `realpath` before the I/O, instead of an atomic resolve-beneath open | Node `fs` has no `openat2`/`RESOLVE_BENEATH`; `O_NOFOLLOW` and `O_EXCL` cover only the final component (Node 22 `fs.constants` docs) | upstream (nodejs/node) | security 1×2 = 2 (a concurrent writer on the vault filesystem swaps a component between check and I/O) | n/a | kept — using the window needs write access to the vault filesystem outside this server, which already grants more than the race |

Minor: the out-of-tier refusal log reads `tools/call` names from the parsed request body before the SDK dispatches, because an unregistered tool is refused inside the SDK with no callback (`unchecked`; Task 2 checks the SDK for an unknown-tool hook first and uses it if one exists).

## Alternatives declined

- **One process per tier** (same image, `MCP_TIER=limited`, a second container holding the limited token). Process isolation removes the token→tier mapping, but it adds a second container writing the same vault and a second upstream at the gateway. It also has a misconfiguration row of the same severity: the wrong `MCP_TIER` on the internet-facing container. And it binds the tier to the deployment, not the credential.
- **A token→scopes JSON map** (`MCP_TOKENS='[{"token":…,"scopes":[…]}]'`). This is general, but it puts secrets inside a structured env value that is easy to log or paste wrong, and two tiers do not need it. The tier allowlists can become scopes later without changing the wire contract.
- **Folder allowlist for `limited` writes** (`MCP_LIMITED_WRITE_DIRS`, recommended by the security seat) — declined by Cameron (D1) in favor of vault-wide create and append, with the code-bearing-note residual accepted.
- **Status quo** (one token, every tool). The gateway credential would be a full credential; it is scored below.

### Risk scoring (security-critical control)

Verdict: **A (tokens → tiers in-process), vault-wide writes per D1, narrowed anonymous mode per D2**. Its highest remaining risk is 6 (code-bearing notes), which Cameron accepted under D1. Every other row is 3 or less, and each Impact-3 row has a named mitigation.

Risk is likelihood and Impact is severity, each 0-3; Score = Risk × Impact, and lower is better. A score of 4 or more, or any Impact 3 with Risk 1 or more, needs a named mitigation. A 6 or 9 in an option's own rows means recommend against that option.

Likelihood assumes the `limited` client is an LLM that reads untrusted content, so content it reads can steer its tool calls without anyone holding the token.

**Security**

| Risk item | Status quo | A. Tokens → tiers | B. Process per tier |
|---|--:|--:|--:|
| Gateway credential calls delete/rename/restore/overwrite | 3×3 = **9** (severe) | 1×3 = **3** (severe; control: registration allowlist, literal-list tests, staged break) | 1×3 = **3** (severe; control: same) |
| Gateway credential writes a file another agent or plugin executes (`.git/config`, `.obsidian/plugins/*`, `CLAUDE.md`, templates) | 3×3 = **9** (severe) | 1×3 = **3** (severe; control: dot-segment and resolved-path policy, `.md`-only, instruction files and daily template refused) | 1×3 = **3** (severe; control: same) |
| A `limited` note carries `dataviewjs` or Templater code that runs on a device when opened or applied (includes appending to a template file) | 2×3 = **6** (severe) | 2×3 = **6** (severe; accepted by the operator — D1, 2026-11-14; depends on Obsidian's Dataview JS and Templater settings) | 2×3 = **6** (severe) |
| Token→tier resolution fails open (limited-only deploy mounts no auth; missing or unknown tier falls back to config) | - | 1×3 = **3** (severe; control: mode table, exhaustive switch, no-config-fallback tests) | - |
| Wrong `MCP_TIER` on the gateway-facing container | - | - | 1×3 = **3** (severe; control: startup log only) |
| Unauthenticated caller reads backup history, plugin data, dot paths | 2×3 = **6** (severe) | 0 (eliminated: D2 `anonymous` allowlist) | 2×3 = **6** (severe) |
| Write follows a dangling symlink out of the vault (reproduced 2026-11-14) | 1×3 = **3** (severe) | 0 (eliminated: Task 1) | 0 (eliminated: Task 1) |
| A limited regex search stalls the server for every tier (ReDoS) | 2×2 = **4** | 0 (eliminated: `regex` refused for `limited`/`anonymous`) | 2×2 = **4** |
| An append loses a concurrent Sync write (read then full rewrite) | 1×2 = 2 | 1×1 = 1 (`O_APPEND` tail; heading insert refuses on mtime/size change) | 1×2 = 2 |
| Check-then-I/O race with a concurrent vault writer (no option changes this) | 1×2 = 2 | 1×2 = 2 | 1×2 = 2 |
| **Worst** | **9** | **3** | **6** |

**Operability**

| Risk item | Status quo | A | B |
|---|--:|--:|--:|
| A misused limited credential leaves no usable trail | 3×2 = **6** | 1×2 = 2 (per-(tier, tool) refusal lines, tier on every line) | 1×2 = 2 |
| Two containers/upstreams drift in version or config | - | - | 2×1 = 2 |

- Effort: A is about a day and a half including tests, runbook, and scripts. B is the same minus the mapping, plus a second container and upstream in the deployment config.
- Risk-3 rows: status quo 2, A 0, B 0.
- No option changes the race row or the code-bearing-note row. The race is narrowed by Task 1's `O_EXCL`. The code-bearing row was accepted under D1; its standalone mitigation is in Obsidian (Dataview "Enable JavaScript Queries" off, Templater's run-on-new-file off) or a later folder allowlist.

## Panel

Panel: plan-reviewer (conflicts), plan-reviewer (task specs), security-posture, operability ran, plus one routed security round — 54 findings, 52 folded in, 2 declined (see Panel review — findings declined)

## Panel review — findings declined

- **[Operability 9] Log the image version or commit at startup and in `/health`** — out of scope for this change; the image's OCI labels already carry the version, and the new `tiers` startup field tells a tiered build from an older one.
- **[Operability 5, sub-item] Narrow the workflow trigger from `v*` to `v[0-9]*`** — no non-release `v` tags exist; changing the release trigger belongs in its own change.

## Architecture

### Mode table

| Configuration | Request | Access |
|---|---|---|
| No token configured, loopback bind | any | `full` (today's loopback mode) |
| No token configured, `MCP_ALLOW_UNAUTHENTICATED=true` | any | `anonymous` |
| Any token configured | valid `MCP_AUTH_TOKEN` | `full` |
| Any token configured | valid `MCP_AUTH_TOKEN_LIMITED` | `limited` |
| Any token configured | missing or invalid token | 401 before body parsing |
| Any token configured | handler reached with `authInfo` missing or `clientId` not a known tier | no tools registered |

When any token is configured, the access comes only from `req.auth.clientId`, never from config, request headers, or `ctx.requestInfo`. The SDK's `requireScopes` is not used as the gate (it passes requests without `authInfo`).

```text
request ─► httpSecurity ─► bearerAuth(tokens) ─► express.json ─► refusal log ─► MCP handler
                          token → clientId                       (tools/call      │
                          401 on no match                         name not in     ▼
                                                                  access)    factory(ctx)
                                                                             access = resolveAccess(config, ctx.authInfo)
                                                                             registry.getServedTools(access)
                                                                             handler(params, { access })
```

- `tools/tiers.ts` (new): `type Access = "full" | "limited" | "anonymous"`; `LIMITED_TOOLS` and `ANONYMOUS_TOOLS` as literal `ReadonlySet<string>`; `toolAllowed(access, name)` as an exhaustive `switch` with `full → true`, `limited`/`anonymous` → set membership, and no default branch that returns `true`; `resolveAccess(config, authInfo)` implementing the mode table. A header comment states that this is a security boundary that fails closed, and that `toolAllowed` must never be wrapped in a catch that returns `true`.
- Single enforcement point: `ToolRegistry.getServedTools(access)` filters with `toolAllowed`. Providers keep `getTools()` with no argument. Handlers gain a second argument `ctx: { access: Access }`.
- `auth.ts`: `bearerAuthMiddleware(tokens: TierTokens, now?)` compares the presented token against every configured token (hash-then-`timingSafeEqual`, all compared) and sets `req.auth = { token, clientId: <tier>, scopes: [] }`. The factory reads `clientId` only. No log line includes `authInfo`.
- `server.ts`: `McpAppOptions` takes `tokens: TierTokens` and `anonymous: boolean` in place of `authToken`/`readOnly`. The middleware is mounted whenever any token is configured.
- `health.ts`: detailed health only for a request that presents the `full` token, or when no token is configured and the bind is loopback (today's local mode). `limited`, `anonymous`, and unauthenticated callers get status only.
- `vault/vault-service.ts`: `resolveSafe` walks each existing component below `realpath(vaultPath)`. Each symlink must `realpath` inside the real root. A dangling symlink is refused. Only `ENOENT` ends the walk as "does not exist"; `ENOTDIR`, `ELOOP`, and `EACCES` refuse. New `createFile` (`flag: "wx"`) and `appendFile` (`flag: "a"`).
- `VaultService.withPolicy(policy)` returns a policy-bound service; the policy is an option on the service itself, so internal walks filter too. Under the `limited`/`anonymous` policy:
  - No path segment starting with `.`, checked on the requested path and on the resolved real path relative to the real root.
  - Walks and trees skip dot entries.
  - Writes only through `createFile`, `appendFile`, and `insertUnderHeading`. `writeFile`, `deleteFile`, and `renameFile` throw. Writes must be `.md`, anywhere outside dot folders (D1), and not an agent-instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, any depth, case-insensitive) or the configured daily-note template.
  - Operator-configured paths (`DAILY_NOTE_TEMPLATE`, `DAILY_NOTE_FOLDER`) are read through the unrestricted service. They are the operator's choice, not the caller's.
- `VaultToolProvider` holds the unrestricted service and the policy-bound one and picks by `ctx.access`.

### Tool placement

| Tool | `full` | `limited` | `anonymous` | Why |
|---|---|---|---|---|
| `read_note`, `vault_structure`, `file_metadata`, `vault_tags`, `search_by_tag`, `search_by_property`, `recent_files`, `get_instructions` | yes | yes | yes | Read is the stated access level; path policy applies |
| `search_content` | yes | yes, `regex` refused | yes, `regex` refused | A caller-supplied regex can stall the event loop for every tier |
| `create_note` | yes | yes, exclusive, `overwrite: true` refused with an error | no | Create is stated; replace is not |
| `append_to_note` | yes | yes | no | Append is stated; tail append uses `O_APPEND`, and a heading insert searches after frontmatter and refuses if the note changed since it was read |
| `daily_note` | yes | yes | no | Reads today's note or creates it exclusively; never replaces. `date` is validated as `YYYY-MM-DD` in every tier |
| `set_frontmatter` | yes | no | no | Replaces existing property values; no add-only form |
| `delete_note`, `delete`, `rename` | yes | no | no | Off until Cameron enables them |
| `backup_restore` | yes | no | no | Overwrites the current note |
| `backup_status`, `backup_history`, `backup_show_file`, `backup_diff`, `backup_snapshots` | yes | no | no | They return content deleted from the live vault and committed files the path policy would refuse (a committed `.obsidian/plugins/*/data.json` can hold API keys); two return an internal service URL |
| `semantic_search`, `backlinks`, `graph_neighbors` | yes | no | no | Served by a separate process this server cannot apply its path policy to; errors echo its internal URL |
| `run_dataview_query` | yes | no | no | The remote plugin can evaluate DataviewJS |

### Logging

- Each request gets a server-generated `requestId`. A gateway-supplied id header MAY be recorded as a separate `upstreamRequestId` field after a format check (`^[A-Za-z0-9._-]{1,64}$`). It is used for correlation only and never feeds authorization.
- Every line the tool wrapper emits carries `tier` and `requestId`: write dispatch (info, one line per call, never throttled), read dispatch (debug), failure (error).
- Refusals (warn) aggregate per `(tier, tool, refusal_kind)`. A key's first hit in a 60 s window logs right away; later hits only add to its count, and the count is flushed when the window ends.
  - `refusal_kind` is one of `out_of_tier`, `dot_segment`, `non_md`, `symlink`, `outside_root`, `write_scope`, `instruction_file`, `overwrite`, `regex`.
  - `tool` is logged only when it matches a registered tool name; any other name is logged as `unknown` plus its length.
  - Refused path values are never logged.
- New refusal messages name the rule and the tier, not the path (`path policy: dot segment refused for tier limited`).
- Startup line: `tiers` (names) replaces `authRequired`. It also carries one `{tier, fingerprint}` per configured token, where the fingerprint is the first 8 hex chars of `SHA-256("obaass-mcp:token-fp:v1:" + token)`. Fingerprints are logged at startup only, never on request lines or in errors.
- Rate limit: `limited` and `anonymous` get a fixed per-minute request cap (a named constant), answered with 429.
- Attribution: every `limited` client shares one token. Per-client attribution depends on the gateway logging the signed-in identity with a request id it forwards here (Task 0 records this dependency on CAM-720). Without that, `limited` writes are attributable only to the tier.

## Tech Stack

- Node 22 (`node:22.23.5-alpine3.24`), TypeScript 5.7, Express 5
- `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/core` 2.3.1, `@modelcontextprotocol/node` 2.1.1, `@modelcontextprotocol/client` 2.3.1. These are the v2 split packages; the repo does not depend on the v1 `@modelcontextprotocol/sdk` the brief names.
- vitest 5 with v8 coverage gates (`npm run test:coverage`), biome (`npm run lint`), `npm run test:smoke`

## Global Constraints

- MUST keep `MCP_AUTH_TOKEN` meaning `full`, with today's tool list. The `full` tier's behavior changes only by these named fixes, which apply to every tier: dangling-symlink refusal, exclusive create when `overwrite` is false, `daily_note` date validation, literal git pathspecs, `O_APPEND` tail append, heading search after frontmatter, and the heading-insert change check.
- MUST treat an empty `MCP_AUTH_TOKEN_LIMITED` as unset. When set, it MUST meet the existing length and whitespace rules and differ from `MCP_AUTH_TOKEN`. Each error names the variable and the fix and interpolates no token value.
- MUST mount the bearer middleware whenever any token is configured.
- MUST define every non-`full` tier as a literal allowlist.
- MUST NOT log token values, `authInfo`, tool argument values, note content, or paths in new refusal messages.
- Tests use throwaway token values only. No real credential is generated or rotated.
- This repo is public: no host names, addresses, or deployment detail in code, commits, the PR, or this plan.
- No merge to `main` (which publishes `latest`) and no `v*` tag without Cameron's go. The Opus security review runs before the merge.
- Residual to document, not fix here: when Obsidian has Dataview JS queries or Templater's run-on-file-creation enabled, a `limited` note can carry code that runs on a device (accepted under D1). The README says so in the tier section and names the two Obsidian settings.

## Live-state claims

| # | Claim the plan relies on | Probe (one read-only command) | Step that acts on it | At pickup | At the acting step |
| -: | ---- | ---- | ---- | ---- | ---- |
| 1 | The installed `@modelcontextprotocol/{server,core,node}` are past every advisory affecting them, including CVE-2026-111771 and CVE-2026-111768 (server fixed in 2.3.0) | `for c in CVE-2026-111771 CVE-2026-111768; do gh api "/advisories?cve_id=$c" --jq '.[].vulnerabilities[]\|select(.package.name\|startswith("@modelcontextprotocol/"))\|[.package.name,.first_patched_version]'; done` plus `npm ls @modelcontextprotocol/server @modelcontextprotocol/core @modelcontextprotocol/node` | Task 3 | CONFIRMED (server 2.3.1 ≥ 2.3.0; no advisory lists core; node's only advisory is fixed in 2.1.0) | |
| 2 | CVE-2026-111771 is about the SDK's bearer-auth helpers, which this server does not use (it has its own `auth.ts`) | `grep -rn "requireBearerAuth\|verifyBearerToken" mcp/src` returns nothing | Task 3 | CONFIRMED | |
| 3 | The image tag `node:22.23.5-alpine3.24` exists | `curl -s "https://hub.docker.com/v2/repositories/library/node/tags/22.23.5-alpine3.24" \| jq -r .name` | Task 3 | CONFIRMED (listed in the hub tag search) | |
| 4 | `toNodeHandler` forwards `req.auth` as the factory's `ctx.authInfo`, in both protocol eras | the `toNodeHandler` doc in `mcp/node_modules/@modelcontextprotocol/node/dist/index.d.mts`, then the Task 2 per-era test | Task 2 | CONFIRMED (types) | |
| 5 | A write through a dangling in-vault symlink lands outside the vault on `origin/main` | `npx vitest run tests/vault/containment.test.ts` (RED) | Task 1 | CONFIRMED | |
| 6 | A `v*` tag push publishes semver tags; a `main` push publishes `main`, short-sha, and `latest` | `grep -n "type=" .github/workflows/mcp-docker.yml` | Task 5 | CONFIRMED | |
| 7 | No open PR touches `mcp/` | `gh pr list --state open --json number,files` | Task 0, Task 5 | CONFIRMED (no open PRs) | |

## Orchestrator

**Driver:** opus — security-critical access control (Model Routing Canon, security row)

---

## Tasks

### Task 0 — Entry

**Dispatch:** In-context · Opus

**Report:** —

**Steps:**

- [x] Record D1/D2 answers in this plan
- [x] Commit the plan; push `-u`; open the draft PR (`Fixes CAM-723`); push after every task from here on
- [x] Post on CAM-720: the final tier names and tool lists (including `anonymous`), the vault-wide write scope, and an FYI that the brief's SDK floor names the v1 package. The v2 packages in use are past both CVEs, and CVE-2026-111771's bearer helper is not used here. gateway-lane's agreement on names and lists gates the ready flip (Task 5), not implementation. Also record the attribution dependency: the gateway logs the signed-in identity with a request id it forwards. Record too that log retention for refusal lines belongs to the deployment side (CAM-722).

### Task 1 — Containment: tests first, then the guard fixes

**Files:**

- Modify: `mcp/src/vault/vault-service.ts`, `mcp/src/tools/vault-tools.ts`, `mcp/src/tools/backup-tools.ts`
- Test: `mcp/tests/vault/containment.test.ts` (exists, RED), `mcp/tests/tools/vault-tools.test.ts`, `mcp/tests/tools/backup-git.test.ts` (new, real temp git repo)

**Interfaces:**

- Produces: `VaultService.createFile(path, content)`, `VaultService.appendFile(path, content)`, hardened `resolveSafe`

**Dispatch:** In-context · Opus — security

**Report:** —

**Steps:**

- [x] Extend `containment.test.ts`: `deleteFile`, `exists`, and rename-source through every escaping link; lexical escapes for `exists`; a populated `outside/sub` read, deleted, and renamed through `linkdir/`; `createFile` symlink cases matched to the refusal regex, not a bare throw
- [x] RED tests in `vault-tools.test.ts`: `create_note` without `overwrite` onto an existing note leaves it unchanged; `daily_note` with `date: "../x"` is refused; a tail append keeps a byte written by another writer between read and write; a heading insert refuses when the note changed; a heading-looking YAML comment inside frontmatter is not a target
- [x] Run — RED on the dangling-symlink, create-onto-existing, and `daily_note` cases
- [x] Fix `resolveSafe` (walk below the real root; dangling refused; only `ENOENT` ends the walk); add `createFile` (`wx`) and `appendFile` (`a`); `create_note` without `overwrite` and `daily_note` use `createFile`; tail append uses `appendFile`; heading insert searches after frontmatter and checks mtime and size before writing; `date` schema `^\d{4}-\d{2}-\d{2}$`
- [x] Backup git calls run with `GIT_LITERAL_PATHSPECS=1` in the `execFile` env. `backup-git.test.ts` builds a real repo with two files and shows that `backup_restore` with `path: "*"` restores neither
- [x] Run — GREEN
- [x] Stage three breaks one at a time, each from a `cp` of the clean file: revert the component walk (dangling tests go red), `wx` → `w` (create-never-replaces goes red), remove the `..`/absolute prefilter (lexical tests go red). Restore and re-run green.
- [x] Commit: `fix(mcp): refuse writes through dangling symlinks; exclusive create and append`

### Task 2 — Tiers bound to the credential

**Files:**

- Create: `mcp/src/tools/tiers.ts`
- Modify: `mcp/src/auth.ts`, `mcp/src/config.ts`, `mcp/src/server.ts`, `mcp/src/index.ts`, `mcp/src/health.ts`, `mcp/src/tools/index.ts`, `mcp/src/tools/types.ts`, `mcp/src/tools/vault-tools.ts`, `mcp/src/vault/vault-service.ts`
- Test: `mcp/tests/tiers.test.ts` (new), `mcp/tests/auth.test.ts`, `mcp/tests/config.test.ts`, `mcp/tests/health.test.ts`, `mcp/tests/server.test.ts`; existing suites that call `createMcpApp(registry, "/mcp")` keep passing unchanged (loopback `full`)

**Interfaces:**

- Consumes: `createFile`, `appendFile` (Task 1)
- Produces: `Access`, `LIMITED_TOOLS`, `ANONYMOUS_TOOLS`, `toolAllowed(access, name)`, `resolveAccess(config, authInfo)`, `bearerAuthMiddleware(tokens, now?)`, `VaultService.withPolicy(policy)`, `ToolDefinition.handler(params, ctx)`

**Dispatch:** Serial (after Task 1) · In-context · Opus — security

**Report:** —

**Steps:**

- [ ] `tiers.test.ts` over a real HTTP app with every provider registered (backup over a real temp git repo, plugin over a stub `PluginClient`):
  - For `full`, `limited`, and `anonymous`, `tools/list` equals a literal name list written in the test, not derived from `LIMITED_TOOLS`.
  - For each out-of-tier tool, `tools/call` returns the SDK's unknown-tool error and causes no side effect (vault tree unchanged).
  - Every in-tier tool succeeds on a valid input.
  - Run the cases in both protocol eras.
- [ ] Policy tests with fixtures outside `IGNORED_DIRS` (`.private/n.md`, root `.hidden.md`):
  - `limited`: refuses them on read and write, hides them from structure, recent files, tags, and searches, and refuses a non-`.md` write (including `.js`).
  - `limited`: refuses a write to `CLAUDE.md` at any depth and any case, and to the template path.
  - `limited`: refuses `overwrite: true` with an error, the file unchanged.
  - `limited`: refuses a read or append through `n.md` → `.private/x` and through `n.md` → `.git/config`.
  - `limited`: `search_content` with `regex: true` is refused.
  - `full`: still sees and writes all of these.
  - No new refusal message contains the input path.
- [ ] Mode-table tests:
  - Limited-only config: a request with no token gets 401, and a request carrying a would-be full token gets 401.
  - With auth configured, a factory call with `authInfo` undefined registers zero tools, and so do `clientId: "Full"` and `clientId: "admin"`.
  - The no-token loopback mode serves every tool; the opt-out mode serves `anonymous`.
  - `/health` gives detail only to the full token, never to `limited` or to an unauthenticated caller in a limited-only deploy.
- [ ] Log tests: N refused calls to one tool in a window produce one line with `count=N`, and a second tool produces its own line. An unregistered name logs as `unknown`. No path value appears in the log output. The startup line carries each fingerprint and no token value or substring of one.
- [ ] Config tests: empty limited var is unset; limited-only starts off-loopback; equal tokens refuse with text naming both variables and containing neither value; length and whitespace rules apply
- [ ] Run — RED
- [ ] Implement per Architecture. That includes the refusal-log hook: check the SDK for an unknown-tool callback first, else read the parsed body. It also includes the tier field on every wrapper line, the `tiers` startup field, `ZodError` issues formatted as `VAR: reason` in the fatal log, and the per-minute cap for `limited`/`anonymous`.
- [ ] Run — GREEN
- [ ] Stage two breaks, one at a time, each from a `cp`: make `getServedTools` ignore access (the out-of-tier tests go red), then bind limited handlers to the unrestricted service (the policy tests go red). Restore both and re-run green.
- [ ] Commit: `feat(mcp): access tiers bound to the bearer token`

### Task 3 — Dependencies and startup checks

**Files:**

- Modify: `mcp/Dockerfile`, `mcp/package-lock.json` (only if `npm audit fix` is transitive-only)
- Create: `mcp/scripts/docker-tier-smoke.sh`

**Dispatch:** Serial (after Task 2) · In-context · Opus

**Report:** —

**Steps:**

- [ ] Re-run Live-state claims 1-3
- [ ] Pin both Dockerfile stages to `node:22.23.5-alpine3.24`
- [ ] `npm audit fix` without `--force` for the `@hono/node-server` advisory; keep it only if the lockfile diff is transitive-only
- [ ] `npm run build && npm run test:coverage && npm run lint && npm run test:smoke`
- [ ] Write `docker-tier-smoke.sh`. It builds the image, runs it with throwaway tokens from `openssl rand -hex 32` against a temp vault, asserts the `tools/list` count per tier, a 401 with no token, and an out-of-tier refusal, removes the container, and exits non-zero on any mismatch. Run it and record the output in this step.
- [ ] Commit: `build(mcp): pin node 22.23.5 base image; tier smoke script`

### Task 4 — Docs, runbook, changelog

**Files:**

- Create: `docs/runbooks/rotate-mcp-tokens.md`
- Modify: `README.md`, `mcp/CHANGELOG.md`

**Dispatch:** Serial (after Task 3) · In-context

**Report:** —

**Steps:**

- [ ] README: `MCP_AUTH_TOKEN_LIMITED`, the mode table, the placement table, the Obsidian JS residual, and that tokens MUST come from `openssl rand -hex 32` or equivalent (no passphrases)
- [ ] Runbook covers:
  - generating and storing a token
  - rotation order (`limited` first, in a window; a rotation is a brief 401 window for that client)
  - the post-restart check
  - rollback to a pre-tier image, including the limited-only case, where the old image refuses to start without `MCP_AUTH_TOKEN`
- [ ] `## Unreleased` entries, kept alongside the existing ones:
  - Added: tiers, `anonymous`
  - Changed: the opt-out mode's tool set, the Node pin
  - Fixed: the dangling-symlink escape, create replacing, `daily_note` traversal, pathspec globs, lost appends, frontmatter heading matches
- [ ] Commit: `docs(mcp): document access tiers and token rotation`

### Task 5 — Review, ready, release hand-off

**Files:**

- Modify: `.github/workflows/mcp-docker.yml` (write tags and digest to `$GITHUB_STEP_SUMMARY`)
- Create: `scripts/release-handoff.sh`

**Dispatch:** Serial (after Task 4) · In-context; review seats as fresh Opus subagents (security)

**Report:** —

**Steps:**

- [ ] Re-run Live-state claims 6 and 7
- [ ] Workflow step summary for tags and digest. `release-handoff.sh <vX.Y.Z>` finds the tag-push run, fails unless it concluded `success`, reads the digest of the semver tag (written only by the tag run), runs `cosign verify` against the digest, and prints `image@sha256:…`
- [ ] run `cadence-forge:polish`; fold findings
- [ ] Security review: `cadence-forge:security-reviewer` (Opus), or `/security-review` or an Opus reviewer if that type does not resolve. File set:
  - `mcp/src/{auth,http-security,server,health,index,config}.ts`
  - `mcp/src/tools/{tiers,index,types,vault-tools,backup-tools,plugin-tools}.ts`
  - `mcp/src/vault/vault-service.ts`
  - `toNodeHandler` in `mcp/node_modules/@modelcontextprotocol/node/dist/index.mjs`
- [ ] gateway-lane has agreed names and lists on CAM-720 (rename and re-run if not); CI green; flip ready; report ready on CAM-720 and `hc send t5k`
- [ ] File on `cameronsjo/obsidi-backup`: the Untitled renamer's `sanitize_title` keeps a leading `.`, so content a `limited` client writes can steer a rename to a dot-prefixed name
- [ ] After Cameron's go: bump `0.1.0` → `0.2.0` in `package.json`, `server.ts`, `health.ts`, and the changelog heading; merge; tag `v0.2.0`; run `scripts/release-handoff.sh v0.2.0`; post its output on CAM-720

---

## Deviations

## Learnings

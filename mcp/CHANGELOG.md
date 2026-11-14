# Changelog

## Unreleased

- Added: access tiers bound to the bearer token. `MCP_AUTH_TOKEN` keeps the `full` tier (every tool). The new `MCP_AUTH_TOKEN_LIMITED` selects `limited`: the read tools, literal-text search, `create_note` for new notes only, `append_to_note`, and `daily_note`. A tool outside the caller's tier is not registered, so it is absent from `tools/list` and refused on `tools/call`. `limited` cannot use dot paths, and it writes only `.md` files, never `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` or the daily-note template. It is capped at 120 requests per minute. See the README's "Access tiers" section and `docs/runbooks/rotate-mcp-tokens.md`.
- Added: audit fields. Every dispatch line carries `tier` and a server-assigned `requestId`, plus `upstreamRequestId` from `MCP_UPSTREAM_REQUEST_ID_HEADER` (default `x-request-id`) when well formed. Refusals log once per tool and kind per minute with a count. Startup logs a fingerprint per configured token.
- Changed: `MCP_ALLOW_UNAUTHENTICATED=true` serves an explicit `anonymous` set (the read tools under the `limited` path policy) instead of every tool marked read-only. Backup history, plugin reads, and dot paths are no longer served without a token.
- Changed: `/health` detail requires the `full` token, or the local loopback mode with no token configured.
- Changed: both image stages pin `node:22.23.5-alpine3.24` instead of the floating `node:22-alpine`.
- Fixed: a write through a dangling in-vault symlink that pointed outside the vault created the file outside it. Every existing path component is now checked, and dangling links are refused.
- Fixed: `create_note` without `overwrite` and `daily_note` could replace a note created between their existence check and the write. Creates are now exclusive.
- Fixed: `daily_note` accepted any `date` string, so `../x` wrote outside the daily folder. `date` must be `YYYY-MM-DD`.
- Fixed: `backup_restore` with `path: "*"` restored every file in the vault. Git now treats every path argument literally.
- Fixed: `append_to_note` rewrote the whole note from a stale read, losing a concurrent edit. A tail append now uses `O_APPEND`, and a heading insert refuses when the note changed. A heading-shaped line inside frontmatter is no longer an insert target.

- Changed: the image workflow pins every third-party action to a full commit
  SHA, with the release version in a trailing comment, so a re-pointed upstream
  tag cannot change what runs in the job that pushes, signs, and attests the
  image. Dependabot (`.github/dependabot.yml`) opens weekly PRs to update the
  pins.
  Minor and patch updates arrive as one grouped PR; major updates arrive
  individually.

- Fixed: the image workflow signed and attested a manifest digest read back
  through the short-sha tag, which a second run for the same commit (a `main`
  push and a `v*` tag push) could overwrite. It now signs and attests the
  digest from its own `imagetools create --metadata-file` result.

- Fixed: the main-branch image build hung on arm64 under QEMU (`npm ci` hit an
  illegal-instruction crash and ran to the 6-hour limit, so nothing published).
  Each platform now builds on a native runner (`ubuntu-24.04-arm` for arm64),
  the manifest is merged afterwards, pull requests build both platforms, and
  every job has a 20-minute timeout.

- **Breaking:** require a credential for MCP access beyond loopback. The default
  bind is now `127.0.0.1`. Set `MCP_AUTH_TOKEN` (at least 32 characters) to
  require `Authorization: Bearer <token>` on the MCP path, compared in constant
  time. A non-loopback bind (including the name `localhost` and the container
  image's `0.0.0.0`) or a non-empty `MCP_ALLOWED_HOSTS` without a token refuses
  to start unless `MCP_ALLOW_UNAUTHENTICATED=true`, which serves read-only
  tools only. Write tools (`create_note`, `append_to_note`, `delete_note`,
  `delete`, `set_frontmatter`, `rename`, `daily_note`, `backup_restore`,
  `run_dataview_query`) are never reachable off loopback without the token.
  `/health` returns status only to callers without the token, and to everyone
  in read-only mode.
  Tools advertise `annotations.readOnlyHint`; write-tool calls are logged.
  `MCP_HTTP_PATH` must be a literal path below `/`, not under `/health`.

- Refresh the security dependency group and align Vitest/coverage-v8 at 5.0.4
  so clean installs no longer fail peer resolution. Development now requires
  Node 22.12+, 24, or 26+ as supported by Vitest 5; coverage floors are unchanged.

- Await asynchronous MCP cleanup before successful process exit, while HTTP
  shutdown starts concurrently and the existing ten-second timeout remains.

- Validate HTTP Host and Origin with the SDK before parsing or dispatch; default
  to loopback at the configured port. `MCP_ALLOWED_HOSTS` explicitly permits
  additional LAN/Tailscale endpoints or HTTPS proxy origins. Existing remote
  clients must opt in; mismatched hosts, schemes or ports now receive 403.

- Reject idle event subscriptions because this service publishes no events;
  expose the real-process SDK smoke probe as `npm run test:smoke`.

- Match `backup_status` to the sidecar’s actual `/health` response; preserve
  unknown fields and tolerate absent optional uptime across sidecar versions.

- Upgrade to the official MCP v2 SDK (server/client 2.3.1, Node adapter 2.1.1).
  HTTP supports protocol 2026-07-28 through a fresh server per request and keeps
  older clients working through the SDK's stateless compatibility handler.

- JSON-returning tools advertise an MCP `outputSchema` and return validated
  `structuredContent` alongside their existing JSON text. `vault_structure` uses
  `{ entries: [...] }` and `recent_files` uses `{ files: [...] }` for the structured
  object; their text fallbacks remain arrays. Other JSON tools keep the same
  object shape in both representations.

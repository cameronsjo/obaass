# Field Report: obsidian-headless Spike

**Date:** 2026-02-28
**Session:** obsidian-standalone-research
**Duration:** ~1 hour
**Outcome:** Architecture-altering discovery validated through hands-on spike

## Summary

Obsidian shipped `obsidian-headless` (npm, v0.0.3) on Feb 27 2026 — an official Node.js CLI that implements the Obsidian Sync protocol without the desktop app. We discovered it, researched it, built a Docker container around it, and validated that it syncs The Compendium vault. This obsoletes the core reason the `obsidi-headless` container (Electron + Xvfb) exists.

## The discovery

Routine check of Obsidian announcements surfaced the headless sync client. Key sources:

- [GitHub repo](https://github.com/obsidianmd/obsidian-headless) — official, maintained by lishid (Obsidian core dev)
- [Sync changelog](https://obsidian.md/changelog/2026-02-27-sync/) — shipped Feb 27 2026
- [Kepano tweet](https://x.com/kepano/status/2027485552451432936) — explicitly listed "give agentic tools access to a vault" as a use case

The package is v0.0.3 (three releases in 10 hours on day one), depends only on `better-sqlite3` + `commander`, and ships as a single bundled `cli.js`.

## What we built

A minimal Docker container (`spike/Dockerfile.headless-sync`):

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache tini su-exec
RUN npm install -g obsidian-headless@0.0.3
```

With an entrypoint that fixes volume permissions and drops privileges:

```bash
chown -R node:node /vault
exec su-exec node "$@"
```

## What we learned

### It works

- `ob sync --continuous` syncs The Compendium in a container
- No keychain bug (the [forum-reported gnome-keyring issue](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679) didn't manifest)
- No Catalyst license required
- Image: 267MB (Node.js base ~240MB + obsidian-headless 28MB)

### It doesn't run plugins

The client is sync-only. It knows about plugin files (syncs `plugins/*/manifest.json`, `main.js`, etc.) but has no plugin loader or execution runtime. obsidi-mcp (an Obsidian plugin) cannot run here.

### The security argument is the strongest one

Before: MCP server ran as an Obsidian plugin inside Electron, with full Node.js integration, access to all other plugins, and the ability to escape the vault directory.

After: MCP server would be a standalone process with filesystem access to exactly one directory. Breach blast radius goes from "arbitrary code execution" to "markdown file access."

This isn't just simplification — it's a fundamental reduction in attack surface.

## Architecture impact

| Component | Before | After |
|-----------|--------|-------|
| Sync | Electron + Xvfb (~400MB) | `ob sync --continuous` (267MB) |
| MCP | Obsidian plugin (inside Electron) | Standalone filesystem MCP (to be built) |
| Backup | obsidi-backup (unchanged) | obsidi-backup (unchanged) |
| Chat UI | obsidi-claude (Obsidian plugin) | Dead — no app to host it |
| License | Catalyst required | Not required |

## What's next

1. **Design vault-mcp** — standalone MCP server for filesystem vault ops (Go or Node.js)
2. **Search architecture** — ripgrep (fast), SQLite FTS5 (ranked), vector embeddings (semantic)
3. **Update threat model** — document reduced blast radius
4. **Update docker-compose.yml** — replace obsidi-headless service
5. **Evaluate vault-sync** — community Go client that bundles Sync + MCP in one binary

## Decisions made

| Decision | Rationale |
|----------|-----------|
| Electron+Xvfb approach is deprecated | Official headless client eliminates the need |
| gnome-keyring not needed | Keychain bug didn't manifest; stripped from image |
| Reuse `node` user (UID 1000) | Already exists in base image, matches host user |
| Entrypoint runs as root then drops | Standard pattern for volume permission fixes |

## Gotchas encountered

- **nvm shell init doesn't persist** across separate bash tool calls — each call is a fresh shell
- **Alpine doesn't have `dbus-launch`** — need `dbus-daemon --session` directly (moot since we stripped dbus)
- **npm version mismatch** — GitHub README said v1.0.0, actual npm registry had v0.0.3
- **UID 1000 collision** — `node:22-alpine` already has `node` user at UID/GID 1000, can't create another

## Related

- Context doc for fresh sessions: `docs/context-headless-sync-spike.md`
- Memory: `~/.claude/projects/-Users-cameron-Projects-obaass/memory/headless-sync-spike.md`
- Prior threat model: `docs/threat-model.md`
- Prior migration analysis: `prompts/obaass-migration-eval.md`

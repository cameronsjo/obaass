# Context: obsidian-headless Spike (2026-02-28)

> Feed this into a fresh session to continue where we left off.

## What happened

Obsidian shipped [`obsidian-headless`](https://github.com/obsidianmd/obsidian-headless) on Feb 27 2026 — an official npm package (v0.0.3, maintainer: lishid) that implements the Obsidian Sync protocol as a standalone Node.js CLI. No Electron, no Xvfb, no desktop app.

We spiked it in a Docker container and validated that it replaces the core reason `obsidi-headless` (the Electron+Xvfb container) exists.

## Spike results

- **Works:** `ob sync --continuous` syncs The Compendium vault in a `node:22-alpine` container
- **No keychain bug:** The [forum-reported gnome-keyring issue](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679) didn't manifest. Stripped gnome-keyring/dbus/libsecret from the image
- **No Catalyst license required** (unlike the Obsidian CLI IPC approach)
- **Image size:** 267MB (Node.js 22 Alpine base ~240MB + obsidian-headless 28MB + tini/su-exec)
- **No plugins:** Sync-only client. Plugin files sync but don't execute. The source is a single bundled `cli.js` with deps on `better-sqlite3` (local sync state) + `commander` (CLI)
- **Spike files:** `spike/Dockerfile.headless-sync` and `spike/entrypoint.sh`

### Container details

- Entrypoint runs as root, fixes `/vault` ownership, drops to `node` user (UID 1000) via `su-exec`
- `OBSIDIAN_AUTH_TOKEN` env var for non-interactive auth, or `ob login` interactively
- `ob sync-setup --path /vault --vault <name>` links local dir to remote vault
- `ob sync --path /vault --continuous` for persistent watch mode
- Conflict strategy: `merge` (configurable)

## Architecture shift

### Before (current, being replaced)

```
obsidi-headless (Electron + Xvfb, ~400MB)
  └── Obsidian desktop app running headlessly
      ├── Obsidian Sync (built into app)
      ├── obsidi-mcp (Obsidian plugin, MCP server)
      ├── obsidi-claude (Obsidian plugin, chat UI)
      └── Obsidian CLI via IPC socket (needs Catalyst license)

obsidi-backup (inotify + git + restic, unchanged)

Auth: Tailscale → Traefik/Authelia → Agentgateway → obsidi-mcp
```

### After (validated by spike)

```
ob sync --continuous (Node.js 22 Alpine, 267MB)
  └── Official Obsidian Sync protocol client
      └── Vault directory (/vault, filesystem)

vault-mcp (TO BE BUILT — standalone MCP server)
  └── Filesystem ops on /vault
      ├── read/write/list (atomic: write-to-temp + rename)
      ├── search (ripgrep, SQLite FTS5, vector embeddings)
      ├── frontmatter (YAML parse/update)
      └── graph (backlinks, tags, wikilink resolution)

obsidi-backup (unchanged)

Auth: Tailscale → Traefik/Authelia → Agentgateway → vault-mcp
```

### What dies

| Component | Why |
|-----------|-----|
| obsidi-headless (Electron container) | Replaced by `ob sync --continuous` |
| obsidi-mcp (Obsidian plugin) | No app to host it — replace with standalone vault-mcp |
| obsidi-claude (Obsidian plugin) | No app for UI |
| Catalyst license requirement | Headless client doesn't need it |

### What lives

| Component | Status |
|-----------|--------|
| obsidi-backup | Unchanged — still watches vault dir via inotify |
| Auth stack | Same pattern, different target (vault-mcp instead of obsidi-mcp) |
| Obsidian Sync subscription | Still required |

## Security improvement (key insight)

The biggest win isn't simplicity — it's security posture.

**Before:** MCP server runs as an Obsidian plugin inside Electron. The plugin has:
- Full Node.js integration via Electron's renderer
- Access to all other plugins, IPC socket, Obsidian internals
- Ability to escape the vault — read arbitrary files, spawn processes
- Plugin supply chain risk (threat model TH-6)

**After:** MCP server is a standalone process with filesystem access to one directory.
- No Electron runtime, no Node integration, no plugin loader
- Attack surface = filesystem ops on markdown files
- Breach blast radius: "markdown file access" not "arbitrary code execution"
- Plugin supply chain risk eliminated entirely

This changes the threat model significantly. TA-1/TH-2/TH-3 (MCP access risks) still apply but with dramatically reduced blast radius.

## Open decisions for next session

### 1. vault-mcp: Build vs adopt

| Option | Pros | Cons |
|--------|------|------|
| **Build our own** (Go) | Exact feature set, aligns with Go migration plan, security-first | Build effort |
| **Build our own** (Node.js) | Same runtime as sync client, fast to prototype | Doesn't advance Go migration |
| **vault-sync** (community Go) | Already built, Sync+MCP in one binary, 8 tools, OAuth 2.1 | Unofficial, undocumented sync protocol, 8 GitHub stars, single maintainer |
| **Existing filesystem MCP** | Many exist (mcp-obsidian, obsidian-mcp-server) | Not vault-aware, no frontmatter/graph |

### 2. Search architecture

| Layer | Tool | Purpose |
|-------|------|---------|
| Fast text | ripgrep | Exact/regex search, zero setup |
| Full-text | SQLite FTS5 | Ranked search, persistent index |
| Semantic | sqlite-vec or hnswlib | "Notes related to X", discovery |

### 3. Atomicity strategy

- `ob sync --continuous` watches filesystem via inotify
- Writes must be atomic: write to temp file → `rename(2)` (POSIX atomic)
- Only server-side writer — conflicts only with device edits via Sync
- Sync's `merge` conflict strategy handles the rest

### 4. Update threat model

- Reduced blast radius on MCP breach
- Eliminated plugin supply chain risk
- New risk: `ob sync` is v0.0.3 — stability/reliability over time unknown

### 5. Update docker-compose.yml

- Replace `obsidi-headless` service with new sync container
- Add `vault-mcp` service
- Remove `obsidian-config` volume (headless client stores state differently)

## Reference links

- [obsidian-headless GitHub](https://github.com/obsidianmd/obsidian-headless)
- [npm package](https://www.npmjs.com/package/obsidian-headless) (v0.0.3)
- [Sync changelog (2026-02-27)](https://obsidian.md/changelog/2026-02-27-sync/)
- [Kepano on headless use cases](https://x.com/kepano/status/2027485552451432936)
- [Keychain bug report](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679)
- [vault-sync (community)](https://github.com/alexjbarnes/vault-sync)
- [Obsidian roadmap](https://obsidian.md/roadmap/)
- Prior obaass memory: `~/.claude/projects/-Users-cameron-Projects-obaass/memory/`

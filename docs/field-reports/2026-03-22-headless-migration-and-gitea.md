# Field Report: Headless Migration + Gitea Integration

**Date:** 2026-03-22
**Session:** obsidian-git-sync-architecture
**Duration:** ~2 hours
**Outcome:** Full stack migrated and deployed to production

## Summary

Migrated obsidi-headless from Electron+Xvfb to the official `obsidian-headless` npm package (v0.0.8), and added git remote push to obsidi-backup so vault commit history lands on Gitea at git.sjo.lol. Both changes deployed to Unraid and confirmed working.

## What we built

### Stream A: Git remote push (obsidi-backup)

Added `GIT_REMOTE_URL` env var. After each auto-commit, the backup container pushes to the configured remote (non-fatal — network failures don't break the backup pipeline). SSH key auth, mounted into the container.

**Files changed:** config.py, backup.py, __main__.py, Dockerfile (+openssh-client), tests (4 new), conftest.py

### Stream B: Headless migration (obsidi-headless)

Complete rewrite of Dockerfile and entrypoint. Replaced Debian+AppImage+Xvfb (~400MB) with `node:22-alpine` + `obsidian-headless@0.0.8` (~180MB). The entrypoint went from 38 lines of Xvfb bootstrapping to 6 lines: permission fix, privilege drop, `ob sync --continuous`.

**Files changed:** Dockerfile, entrypoint.sh, README.md, NOTICE.md, version.txt (1.0.0 -> 2.0.0)

### Integration (obaass)

Updated docker-compose.yml (new volume paths, GIT_REMOTE_URL, SSH key mount), .env.example, and architecture docs (new diagrams reflecting the simplified stack).

## Deployment

Both streams executed in parallel via subagents, then deployed to Unraid:

1. Merged PRs, CI built new images
2. SSH'd into Unraid, copied SSH key, updated compose, pulled images
3. Created Gitea repo (`cameron/the-compendium`) via Playwright + Gitea web UI
4. Added SSH public key to Gitea account via Playwright
5. Ran `ob login` + `ob sync-setup` interactively in the headless container
6. Restarted both containers — sync running, first git push confirmed

## Gotchas

### su-exec doesn't set HOME

The biggest issue. `su-exec` (and `gosu`) only change UID/GID — they don't set up a login environment. `ob login` stored credentials relative to `$HOME`, which was still root's home, not `/config`. Credentials were lost on container restart.

**Fix:** Add `ENV HOME=/config` to the Dockerfile. Filed as a follow-up commit.

**Lesson:** When using privilege-dropping tools in containers, always set HOME explicitly via ENV. `adduser -h /path` sets passwd but su-exec doesn't read passwd.

### Gitea SSH on port 222

git.sjo.lol runs SSH on port 222, so the remote URL is `ssh://git@git.sjo.lol:222/cameron/the-compendium.git`, not the standard `git@git.sjo.lol:cameron/...` shorthand. The `ssh://` scheme is required when specifying a non-default port.

### Container name conflict

The old backup container was started outside of compose (via Unraid Docker UI). `docker compose up -d` couldn't reuse the name. Had to `docker stop && docker rm` first.

### obsidian-headless npm is UNLICENSED

Still `UNLICENSED` on npm as of v0.0.8. Noted in NOTICE.md. Matters if redistributing the built image.

## Architecture impact

| Component | Before | After |
|-----------|--------|-------|
| Sync | Electron + Xvfb (~400MB) | `ob sync --continuous` (~180MB) |
| MCP | Obsidian plugin (inside Electron) | Standalone (to be built) |
| Backup | Git local-only + restic | Git local + push to Gitea + restic |
| Chat UI | obsidi-claude (Obsidian plugin) | Dead — no app to host it |

## Decisions made

| Decision | Rationale |
|----------|-----------|
| Non-fatal git push | Commit and restic backup must complete even if Gitea is down |
| SSH key auth over token | Standard for server-to-server, key never leaves the container |
| UID 99:100 preserved | Unraid compatibility, shared vault volume |
| Version bump to 2.0.0 | Breaking change: new volume paths, new base image |
| Mount `/root/.ssh` as whole dir | Need both key and known_hosts inside container |

## What's next

- Redeploy headless once CI ships image with baked-in `HOME=/config` (bead obaass-81q)
- Design standalone vault-mcp server (filesystem ops, no Electron)
- Consider composefile for the headless container (currently `docker run`)

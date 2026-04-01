# GitHub <-> Obsidian Sync

Bidirectional sync between a GitHub repo and an Obsidian vault. GitHub is the collaboration layer. Obsidian is the knowledge layer.

## The Use Case

A collaborative knowledge base — like [dev-encyclopedia](https://github.com/cameronsjo/dev-encyclopedia) — where the content is an Obsidian vault that lives in a GitHub repo. Contributors work through the GitHub experience: PRs, web editor, Claude Code, forks. The vault on the server pulls those changes and Obsidian does what Obsidian does — graph view, backlinks, dataview, MCP.

Changes flow both ways:

- **GitHub -> Obsidian**: A contributor merges a PR. The server pulls it. Obsidian renders it. Your phone gets it via Sync.
- **Obsidian -> GitHub**: An AI agent writes a note via MCP. The sync service commits and pushes. It shows up on GitHub. Other contributors see it.

## How It Differs From Default obaass

Default obaass:

```
Devices <-> Obsidian Sync <-> obsidi-headless <-> obsidi-backup -> git -> offsite
```

Everything starts at the device. Obsidian Sync moves changes to the server. obsidi-backup commits them to git as a backup destination. Git is downstream. Nobody edits on GitHub.

GitHub <-> Obsidian:

```
GitHub (PRs, web editor, Claude Code)
    ^
    |  git pull / git push
    v
Vault on server (git clone)
    ^
    |
    v
obsidi-headless (graph, backlinks, MCP, plugins)
    ^
    |  Obsidian Sync (optional)
    v
Your devices
```

GitHub becomes a peer, not a backup target. The vault is a `git clone`. obsidi-backup gets repurposed — instead of just committing, it also pulls. Instead of encrypting offsite, it pushes to GitHub. GitHub handles the history, collaboration, and backup.

### What changes

| Component | Default obaass | GitHub <-> Obsidian |
|-----------|---------------|-------------------|
| Source of truth | Your devices (via Obsidian Sync) | GitHub repo |
| obsidi-backup | Watches vault -> commits -> encrypts offsite | Becomes **obsidi-sync**: pulls from GitHub, commits local changes, pushes back |
| obsidi-headless | Receives changes via Sync | Receives changes via `git pull` (and still via Sync if enabled) |
| Obsidian Sync | Required (how changes reach the server) | Optional (distributes to devices) |
| Obsidian Catalyst | Required (for CLI) | Only if you use Sync or MCP |
| obsidi-mcp | Full read/write, changes stay local | Full read/write, changes push to GitHub |
| Restic / offsite backup | Core feature | Not needed — GitHub is the history |

### What stays the same

- obsidi-headless still runs headlessly — Obsidian needs it for plugins, rendering, MCP
- obsidi-mcp still works — AI agents can read and write the vault
- Auth layer is still recommended if exposing MCP
- Docker Compose still orchestrates everything

## Architecture

```mermaid
graph TB
    subgraph contributors["Contributors"]
        direction LR
        pr["Pull Requests"]
        web["GitHub Web Editor"]
        claude_code["Claude Code"]
    end

    github["GitHub Repo"]

    subgraph server["the safe-ish stack"]
        sync_svc["obsidi-sync<br/>pull + commit + push"]

        subgraph headless["obsidi-headless"]
            obs_app["Obsidian App"]
            obs_mcp["obsidi-mcp plugin"]
        end

        vault["Vault<br/>(git clone)"]
    end

    sync_cloud["Obsidian Sync Cloud"]

    subgraph devices["Devices (optional)"]
        phone["Phone / iPad"]
        desktop["Desktop Obsidian"]
    end

    pr --> github
    web --> github
    claude_code --> github

    github <-->|pull / push| sync_svc
    sync_svc --> vault
    vault --> obs_app
    obs_mcp -->|writes| vault

    obs_app <-->|if Sync enabled| sync_cloud
    sync_cloud <--> phone
    sync_cloud <--> desktop
```

## The Sync Service

obsidi-backup gets repurposed into a two-way sync loop: pull remote changes, detect local changes, commit and push them back.

```bash
#!/bin/bash
POLL_INTERVAL="${POLL_INTERVAL:-60}"
BRANCH="${GIT_BRANCH:-main}"

cd "$VAULT_PATH"

while true; do
    # 1. commit any local changes (MCP writes, Sync edits)
    git add -A
    if ! git diff --cached --quiet; then
        MSG="vault: $(date -Iseconds)"
        git commit -m "$MSG" --quiet
    fi

    # 2. pull remote changes, rebase local commits on top
    git pull --rebase origin "$BRANCH" --quiet

    # 3. push local commits to GitHub
    git push origin "$BRANCH" --quiet 2>/dev/null

    sleep "$POLL_INTERVAL"
done
```

The loop is: commit local, pull remote, push local. Every `POLL_INTERVAL` seconds. If there's nothing to commit, it just pulls. If there's nothing to pull, it just pushes. If there's nothing at all, it sleeps.

### Conflict Resolution

With `git pull --rebase`, local commits get replayed on top of remote changes. For a knowledge base where different people edit different notes, conflicts are rare. When they do happen:

- **Automatic merge**: Git handles non-overlapping changes in the same file automatically
- **Conflict**: If two people edit the same lines, `git rebase` fails. The sync service should detect this, abort the rebase, and use a merge commit instead — or create a `.conflict` copy and notify

For most vaults, the simple version works. If you're collaborating heavily on the same files, you probably want PR-based workflow on those files anyway.

### Polling vs Webhooks

| Approach | Pros | Cons |
|----------|------|------|
| **Polling** (recommended) | No exposed ports, works behind NAT, dead simple | Up to `POLL_INTERVAL` delay |
| **Webhook** | Real-time updates | Requires exposed endpoint, auth, more attack surface |

Polling every 60 seconds means your vault is at most a minute behind GitHub. For a knowledge base, that's fine.

## docker-compose Changes

The `backup` service gets replaced with a `sync` service:

```yaml
services:
  obsidian:
    image: ghcr.io/cameronsjo/obsidi-headless:latest
    volumes:
      - obsidian-config:/config
      - ./vault:/config/vaults/default

  sync:
    image: ghcr.io/cameronsjo/obsidi-sync:latest  # or obsidi-backup repurposed
    environment:
      VAULT_PATH: /vault
      GIT_REMOTE_URL: https://github.com/your-org/your-vault.git
      GIT_BRANCH: main
      POLL_INTERVAL: 60
    volumes:
      - ./vault:/vault

volumes:
  obsidian-config:
```

Things that go away: `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `BACKUP_DEBOUNCE`. The sync service only needs a repo URL, a branch, and a polling interval.

Things that could stay: `ANTHROPIC_API_KEY` for AI commit messages on the push side (instead of `vault: 2025-01-15T...`), `DISCORD_WEBHOOK_URL` for sync notifications.

### Private repos

For private GitHub repos, use a GitHub App token or deploy key:

```yaml
sync:
  environment:
    GIT_REMOTE_URL: https://x-access-token:${GITHUB_TOKEN}@github.com/your-org/your-vault.git
```

Or mount an SSH key and use the SSH URL.

## MCP in Both Directions

MCP writes work naturally in this pattern. An AI agent writes a note via obsidi-mcp, the sync service picks it up, commits, and pushes to GitHub. The note shows up in the repo like any other change.

This means you get two contribution paths:

1. **Humans via GitHub** — PRs, web editor, Claude Code. Review process, branch protection, CI checks. The deliberate path.
2. **AI agents via MCP** — Direct writes to the vault. Committed and pushed automatically. The fast path.

Whether you want both paths open is a design decision. For a shared encyclopedia, you might want MCP to be read-only so all changes go through PR review. For a personal vault with AI assistants, full read/write MCP makes sense.

## When to Use This Pattern

Use **GitHub <-> Obsidian** when:
- Multiple people contribute to the vault
- You want the GitHub experience — PRs, code review, issues, branch protection
- The vault is a reference (encyclopedia, docs, wiki) that benefits from collaboration tooling
- You want AI agents to read (and optionally write) the knowledge base
- Git history is your backup strategy

Use **default obaass** when:
- You're the only contributor
- You edit primarily on your phone/laptop via Obsidian
- You want Obsidian Sync as the primary transport
- You want encrypted offsite backup via restic
- The vault is personal (daily notes, journals, fleeting thoughts)

## What This Enables

```
Contributor opens PR on GitHub
    -> Review, discuss, merge
    -> Server pulls in 60 seconds
    -> Obsidian renders with graph view, backlinks, dataview
    -> AI agents can query the knowledge base via MCP
    -> Optionally syncs to devices for offline reading

AI agent writes a note via MCP
    -> Sync service commits and pushes
    -> Shows up on GitHub
    -> Other contributors see it, can edit, discuss
    -> Devices get it via Sync
```

GitHub gives you the collaboration layer that Obsidian doesn't have — issues, PRs, code review, branch protection, CI. Obsidian gives you the knowledge layer that GitHub doesn't have — graph visualization, backlinks, transclusion, community plugins.

Each tool does what it's good at. Neither pretends to be the other.

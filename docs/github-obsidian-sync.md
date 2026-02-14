# GitHub -> Obsidian Sync

One-way sync from a GitHub repo into an Obsidian vault. GitHub is the source of truth. Obsidian is the reader.

## The Use Case

A collaborative knowledge base — like [dev-encyclopedia](https://github.com/cameronsjo/dev-encyclopedia) — where the content is an Obsidian vault that lives in a GitHub repo. People contribute through the GitHub experience: PRs, web editor, Claude, forks. The vault on the server pulls those changes and Obsidian does what Obsidian does — graph view, backlinks, dataview, MCP.

**The editing experience is GitHub. The reading experience is Obsidian.**

This is intentionally one-way. Changes on GitHub flow into the vault. The vault does not push back. If you want bidirectional sync, that's a different (harder, messier) problem and you should look at the default obaass pattern instead.

## How It Differs From Default obaass

Default obaass:

```
Devices <-> Obsidian Sync <-> obsidi-headless <-> obsidi-backup -> git -> offsite
```

Everything starts at the device. Obsidian Sync moves changes to the server. obsidi-backup commits them to git. The backup is downstream.

GitHub -> Obsidian:

```
GitHub (PRs, web editor, Claude)
    |
    v  git pull
Vault on server
    |
    v  Obsidian renders it
obsidi-headless (graph, backlinks, MCP, plugins)
    |
    v  Obsidian Sync (optional)
Your devices
```

Everything starts at GitHub. The vault is a `git clone`. obsidi-headless gives you the Obsidian experience on top of it. Obsidian Sync is optional — only needed if you also want the content on your phone.

### What changes

| Component | Default obaass | GitHub -> Obsidian |
|-----------|---------------|-------------------|
| Source of truth | Your devices (via Obsidian Sync) | GitHub repo |
| obsidi-backup | Watches vault, commits to git, encrypts offsite | **Not needed** — GitHub IS the backup |
| obsidi-headless | Receives changes via Sync | Receives changes via `git pull` |
| Obsidian Sync | Required (how changes reach the server) | Optional (distributes to devices) |
| Obsidian Catalyst | Required (for CLI) | Only if you use Sync or MCP |
| obsidi-mcp | Full read/write | Read-only recommended (writes wouldn't flow back to GitHub) |

### What stays the same

- obsidi-headless still runs headlessly — Obsidian needs it for plugins, rendering, MCP
- obsidi-mcp still works — AI agents can read the vault
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

    github["GitHub Repo<br/>(source of truth)"]

    subgraph server["the safe-ish stack"]
        sync_svc["obsidi-sync<br/>periodic git pull"]

        subgraph headless["obsidi-headless"]
            obs_app["Obsidian App"]
            obs_mcp["obsidi-mcp plugin<br/>(read-only)"]
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

    github -->|git pull| sync_svc
    sync_svc --> vault
    vault --> obs_app
    obs_app -->|if Sync enabled| sync_cloud
    sync_cloud --> phone
    sync_cloud --> desktop
```

## The Sync Service

obsidi-backup gets replaced (or repurposed) with a simpler service: poll GitHub for changes. The whole thing fits in a script.

```bash
#!/bin/bash
POLL_INTERVAL="${POLL_INTERVAL:-60}"
BRANCH="${GIT_BRANCH:-main}"

cd "$VAULT_PATH"

# initial clone happens at container startup
while true; do
    git fetch origin "$BRANCH" --quiet
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")

    if [ "$LOCAL" != "$REMOTE" ]; then
        git reset --hard "origin/$BRANCH"
        echo "$(date -Iseconds) synced to $(git rev-parse --short HEAD)"
    fi

    sleep "$POLL_INTERVAL"
done
```

That's it. No inotify, no debounce, no AI commit messages, no restic. GitHub handles the history. GitHub handles the backup. The sync service just pulls.

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

Things that go away: `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `DISCORD_WEBHOOK_URL`, `BACKUP_DEBOUNCE`. The sync service only needs a repo URL, a branch, and a polling interval.

### Private repos

For private GitHub repos, mount a deploy key or use a GitHub App token:

```yaml
sync:
  environment:
    GIT_REMOTE_URL: https://x-access-token:${GITHUB_TOKEN}@github.com/your-org/your-vault.git
```

Or mount an SSH key and use the SSH URL.

## MCP Considerations

In the default obaass pattern, obsidi-mcp has full read/write access. An AI agent can create, edit, and delete notes. Those changes propagate via Sync and get backed up.

In the GitHub -> Obsidian pattern, MCP writes are a problem. If an AI writes a note via MCP, the change is local to the server. It won't appear on GitHub. Next `git pull` will overwrite it.

**Options:**

1. **Read-only MCP** — simplest. AI agents can read and search but not write. This is probably what you want for a shared knowledge base.

2. **MCP writes create PRs** — the AI agent writes to a staging area, and the sync service commits and pushes a PR to GitHub. The change goes through the same review process as any other contribution. More complex but preserves the one-way model.

3. **Accept local-only writes** — if you're okay with notes that exist on the server but not on GitHub. Fragile and confusing. Not recommended.

## When to Use This Pattern

Use **GitHub -> Obsidian** when:
- Multiple people contribute to the vault
- You want PR-based review of content changes
- The GitHub editing experience (web editor, Claude Code, forks) is how people interact with the content
- You don't need every device to push changes back
- The vault is a reference (encyclopedia, docs, wiki), not a personal daily-driver

Use **default obaass** when:
- You're the only contributor
- You edit primarily on your phone/laptop via Obsidian
- You want bidirectional sync across all devices
- The vault is personal (daily notes, journals, fleeting thoughts)

## What This Enables

The dev-encyclopedia pattern:

```
Contributor opens PR on GitHub
    -> Review, discuss, merge
    -> Server pulls in 60 seconds
    -> Obsidian renders with graph view, backlinks, dataview
    -> AI agents can query the knowledge base via MCP
    -> Optionally syncs to devices for offline reading
```

GitHub gives you the collaboration layer that Obsidian doesn't have — issues, PRs, code review, branch protection, CI. Obsidian gives you the knowledge layer that GitHub doesn't have — graph visualization, backlinks, transclusion, community plugins.

Each tool does what it's good at. Neither pretends to be the other.

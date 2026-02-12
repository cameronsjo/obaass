# OBaaSS — Obsidian As-a Safe-ish Service

Run Obsidian headlessly on a server. One `docker compose up` gives you three compounding capabilities:

1. **AI Agent Access** — Claude (or any MCP client) can read and write your vault
2. **Encrypted Backup** — Every change gets a git commit + offsite encrypted backup
3. **Multi-Device Sync** — Obsidian Sync keeps the server copy current with all your devices

## Why

Obsidian is a desktop app. No server mode. No native API. Sync is built into the desktop client. Every feature assumes a human sitting at a screen.

OBaaSS solves this by running the desktop app headlessly on a server. That single decision unlocks capabilities Obsidian was never designed to support — and they compound:

- AI writes a note via MCP -> Sync propagates to all devices -> Backup captures the change
- Phone edit via Sync -> Server receives it -> Backup captures it -> AI can read it via MCP
- Backup restores a file -> Sync propagates the restore -> AI and all devices see it

Your vault becomes a **living, distributed knowledge base** accessible from any device, any AI agent, and recoverable from any point in time.

## Quick Start

```bash
git clone https://github.com/cameronsjo/obaass.git
cd obaass
cp .env.example .env
# Edit .env with your settings

mkdir -p vault  # Or point VAULT_PATH to an existing vault
docker compose up -d
```

### First-Time Sync Setup

After the first boot, enable Obsidian Sync to pull your vault:

1. The Obsidian app is running headlessly — there's no GUI to click through
2. Use the CLI to configure sync (see [docs/sync-setup.md](docs/sync-setup.md))
3. Once authenticated, Sync runs automatically on every restart

## Architecture

```
                    docker compose up
                          |
          +---------------+---------------+
          |                               |
  +-----------------+          +--------------------+
  |    obsidian     |          |       backup       |
  |                 |          |                    |
  |  Xvfb + App    |          |  inotify watcher   |
  |  Obsidian Sync |          |  Git auto-commit   |
  |  CLI ready     |          |  Restic encrypted   |
  +--------+--------+          |  AI commit msgs    |
           |                   +----------+---------+
           v                              v
  +------------------------------------------------+
  |            Shared vault volume                  |
  +------------------------------------------------+
```

## Components

| Service | Image | Purpose |
|---------|-------|---------|
| `obsidian` | [`obsidian-headless`](https://github.com/cameronsjo/obsidian-headless) | Obsidian desktop app running headlessly via Xvfb |
| `backup` | [`obsidian-vault-backup`](https://github.com/cameronsjo/obsidian-vault-backup) | File watcher + git + restic + AI commit messages |

## Configuration

All configuration is via environment variables in `.env`. See [.env.example](.env.example) for the full list.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_PATH` | `.` | Directory containing your `vault/` folder |
| `TZ` | `UTC` | Timezone |

### Backup

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_DEBOUNCE` | `300` | Seconds to wait after last change before committing |
| `GIT_USER_NAME` | `Obsidian Backup` | Git author name |
| `GIT_USER_EMAIL` | `backup@local` | Git author email |

### Offsite Backup (Optional)

| Variable | Description |
|----------|-------------|
| `RESTIC_REPOSITORY` | Restic repo URL (S3, Azure, B2, local path) |
| `RESTIC_PASSWORD` | Encryption password for the restic repository |

### AI Commit Messages (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key for AI-generated commit messages |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Model to use |

### Notifications (Optional)

| Variable | Description |
|----------|-------------|
| `DISCORD_WEBHOOK_URL` | Discord webhook for backup notifications |

## How It Works

### Obsidian Headless

The [`obsidian-headless`](https://github.com/cameronsjo/obsidian-headless) image runs the Obsidian desktop app with a virtual framebuffer (Xvfb) instead of a real display. Electron needs a display server — Xvfb satisfies that requirement with zero overhead. No VNC, no desktop environment, no window manager.

Obsidian Sync runs inside the app, keeping the server-side vault in sync with all your devices. The native CLI (Obsidian 1.12+) provides programmatic access.

### Vault Backup

The [`obsidian-vault-backup`](https://github.com/cameronsjo/obsidian-vault-backup) sidecar watches the vault directory for filesystem changes using inotify. After a configurable debounce period (default: 5 minutes), it:

1. Commits changes to git with an AI-generated message (or falls back to a timestamp)
2. Pushes to a restic repository for encrypted, deduplicated offsite backup
3. Optionally notifies via Discord

Retention policy: 7 daily, 4 weekly, 12 monthly snapshots.

## License

MIT

---
name: obaass
description: "Get started with obaass — what it is, how to set it up, and how to use it"
---


Guide the user through getting started with **obaass** (Obsidian as-a Safe-ish Service).

## About

obaass runs the Obsidian desktop app headlessly on a server via Docker. One `docker compose up` gives you three compounding capabilities: multi-device sync (via Obsidian Sync), encrypted backup (git commits with AI-generated messages + restic offsite), and AI agent access (Claude or any MCP client can read/write your vault via obsidi-mcp).

## Prerequisites

Check that the user has the following installed/configured:

- Docker and Docker Compose
- An Obsidian vault (or an empty directory to start one)
- Obsidian Sync subscription (for multi-device sync)
- Obsidian Catalyst license (required for CLI access used by obsidi-mcp)
- (Optional) Anthropic API key for AI-generated commit messages
- (Optional) Restic repository credentials for offsite encrypted backup
- (Optional) Discord webhook URL for backup notifications

## Setup

Walk the user through initial setup:

1. Clone the repo:
   ```bash
   git clone https://github.com/cameronsjo/obaass.git
   cd obaass
   ```
2. Copy the example environment file and edit it:
   ```bash
   cp .env.example .env
   ```
3. At minimum, configure `VAULT_PATH` in `.env`. This is the directory that will contain your `vault/` folder.
4. Create the vault directory if it doesn't exist:
   ```bash
   mkdir -p vault
   ```
5. Start the stack:
   ```bash
   docker compose up -d
   ```
6. First-time sync setup: Obsidian is running headlessly with no GUI. Use the CLI to configure Obsidian Sync. See `docs/sync-setup.md` for the full walkthrough.

## First Use

Guide the user through their first interaction with the product:

1. Verify both containers are running:
   ```bash
   docker compose ps
   ```
   You should see `obsidian` and `backup` services both up.
2. Check the backup sidecar logs to confirm it's watching the vault:
   ```bash
   docker compose logs backup
   ```
3. Once Sync is configured, make a change on any synced device. After the debounce period (default: 5 minutes), check that the backup sidecar committed the change:
   ```bash
   docker compose exec backup git -C /vault log --oneline -5
   ```

## Key Files

Point the user to the most important files for understanding the project:

- `docker-compose.yml` — Service definitions for obsidian (headless) and backup (sidecar)
- `.env.example` — All configurable environment variables with descriptions
- `docs/architecture.md` — Detailed backup pipeline, data flow, and compounding capabilities model
- `docs/sync-setup.md` — Step-by-step guide for first-time Obsidian Sync configuration
- `docs/mcp-integration.md` — Setting up obsidi-mcp for AI agent access
- `docs/threat-model.md` — Security considerations and threat model

## Common Tasks

- **Start the stack**:
  ```bash
  docker compose up -d
  ```
- **Stop the stack**:
  ```bash
  docker compose down
  ```
- **View backup logs**:
  ```bash
  docker compose logs -f backup
  ```
- **Check recent backup commits**:
  ```bash
  docker compose exec backup git -C /vault log --oneline -10
  ```
- **Force a backup** (skip debounce): See the backup sidecar documentation for manual trigger options.

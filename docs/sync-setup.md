# Sync Setup

How to configure Obsidian Sync on the headless server. No GUI, no problem.

## Prerequisites

- **Obsidian Sync subscription** — the server needs to join your sync vault
- **Obsidian Catalyst license** — required for CLI access (how we talk to the headless app)
- A running `obsidi-headless` container (`docker compose up -d obsidian`)

## How Sync Works Here

Obsidian Sync is built into the desktop app. It's not an API, not a daemon, not a service — it's a feature inside the Electron app that phones home to Obsidian's relay servers.

obaass runs the full desktop app headlessly. Sync runs inside it, same as it would on your laptop. The difference: there's no screen to click "Enable Sync" on. You use the CLI instead.

## First Boot

On first boot, the obsidian container starts with an empty config volume and the vault directory you pointed it at:

```yaml
volumes:
  - obsidian-config:/config
  - ${VAULT_PATH:-.}/vault:/config/vaults/default
```

Sync is **not** enabled yet. The app is running, but it doesn't know your Obsidian account credentials.

## Enabling Sync via CLI

<!-- TODO(#obaass-1qa): Validate these CLI commands after deployment -->

Shell into the running container:

```bash
docker compose exec obsidian bash
```

Use the Obsidian CLI to authenticate and enable sync:

```bash
# Log in to your Obsidian account
obsidian --login

# List available sync vaults
obsidian --list-vaults

# Connect this instance to your sync vault
obsidian --sync-enable --vault <vault-id>
```

The CLI talks to the running app via IPC (Unix socket). The app must be running — the CLI doesn't work standalone.

## Verifying Sync

After enabling, confirm sync is active:

```bash
# Check sync status
obsidian --sync-status
```

You should see:
- Connection state: connected
- Remote vault: your vault name
- Last sync: a recent timestamp

From another device, make a small edit (add a line to any note). Within seconds, check the server vault:

```bash
# Inside the container
cat /config/vaults/default/<your-note>.md
```

If the edit appears, sync is working.

## Persistence

Sync credentials are stored in the `obsidian-config` Docker volume. As long as that volume exists, sync will reconnect automatically on container restart. You only need to run the setup once.

If you destroy the config volume (`docker volume rm`), you'll need to re-authenticate.

## Troubleshooting

### Sync won't connect

- Verify the container can reach `sync-xx.obsidian.md` (Obsidian's sync servers)
- Check container logs: `docker compose logs obsidian`
- Ensure your Sync subscription is active

### Changes aren't propagating

- Sync has a short delay (usually < 10 seconds)
- The debounce in obsidi-backup is separate — that's 5 minutes by default. Don't confuse backup timing with sync timing
- Check if another device has conflicting changes (Sync creates `<note> (conflict).md` files)

### "CLI not found" or IPC errors

- The CLI requires Obsidian 1.8+ and a Catalyst license
- The app must be running (`docker compose ps` should show obsidian as "Up")
- The CLI connects via `/tmp/obsidian-ipc.sock` inside the container — if it's missing, the app didn't start correctly

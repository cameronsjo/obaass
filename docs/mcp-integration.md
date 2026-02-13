# MCP Integration

How to give AI agents read/write access to your vault via MCP (Model Context Protocol).

## What This Enables

Once configured, AI agents can:

- Read and search notes in your vault
- Create and edit notes
- Manage tags and metadata
- Query your knowledge base programmatically

The MCP server runs inside the headless Obsidian app as a plugin. Agents connect to it through your auth layer.

## Architecture

```
Claude.ai ──MCP──> Tailscale ──> Traefik/Authelia ──> Agentgateway ──> obsidi-mcp
                                                                         │
Desktop Obsidian ──MCP──> Traefik/Authelia ──> Agentgateway ────────────┘
  (obsidi-claude)
```

Two entry points, same destination. Claude.ai connects from the internet via Tailscale. The desktop plugin connects through your local auth layer.

## Components

| Component | Role | Required? |
|-----------|------|-----------|
| [obsidi-mcp](https://github.com/cameronsjo/obsidi-mcp) | MCP server plugin inside headless Obsidian | Yes |
| [Agentgateway](https://github.com/agentgateway/agentgateway) | MCP-aware reverse proxy — routes, rate-limits, logs agent traffic | Recommended |
| [Traefik](https://traefik.io/) + [Authelia](https://www.authelia.com/) | HTTPS termination + authentication | Recommended |
| [Tailscale](https://tailscale.com/) | Encrypted mesh network — exposes services without port forwarding | Recommended |
| [obsidi-claude](https://github.com/cameronsjo/obsidi-claude) | Desktop chatbot plugin that connects to the server | Optional |

The auth layer is optional but recommended. Without it, your vault is one open port away from the internet.

## Setup

### 1. Install obsidi-mcp in the headless container

<!-- TODO(#obaass-02y): Validate plugin installation method after container build -->

The plugin needs to be installed inside the headless Obsidian instance. Options:

- **Bake it into the image** — include the plugin in the obsidi-headless Dockerfile
- **Mount it as a volume** — bind-mount the plugin directory into the container's vault plugins folder
- **Install via CLI** — use the Obsidian CLI to install community plugins

```yaml
# Example: mount plugin directory
volumes:
  - ./plugins/obsidi-mcp:/config/vaults/default/.obsidian/plugins/obsidi-mcp
```

### 2. Configure Agentgateway

Agentgateway sits between your auth layer and obsidi-mcp. It handles MCP protocol routing, rate limiting, and audit logging.

<!-- TODO(#obaass-wmj): Document Agentgateway config after implementation -->

```yaml
# docker-compose.override.yml (example)
services:
  agentgateway:
    image: ghcr.io/agentgateway/agentgateway:latest
    restart: unless-stopped
    environment:
      UPSTREAM_MCP_URL: http://obsidian:3000  # obsidi-mcp's port
    ports:
      - "8080:8080"
```

### 3. Configure Auth Layer

The auth stack (Tailscale + Traefik + Authelia) is shared infrastructure — it's not obaass-specific. If you already have this running on your homelab, point it at the Agentgateway.

If you don't have an auth layer yet, the short version:

- **Tailscale** creates an encrypted mesh network between your devices and server. No port forwarding needed
- **Traefik** terminates HTTPS and routes traffic
- **Authelia** adds authentication (SSO, 2FA) in front of services

This is a meaningful infrastructure decision. See [Tailscale docs](https://tailscale.com/kb), [Traefik docs](https://doc.traefik.io/traefik/), and [Authelia docs](https://www.authelia.com/docs/) for setup guides.

### 4. Connect Claude.ai

In Claude.ai's MCP settings, add the server:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://your-agentgateway-endpoint.ts.net/mcp"
    }
  }
}
```

The exact URL depends on your Tailscale hostname and Traefik routing config.

### 5. Connect obsidi-claude (Desktop Plugin)

Install the [obsidi-claude](https://github.com/cameronsjo/obsidi-claude) plugin in your desktop Obsidian app. In its settings, configure the server URL to point at your auth layer:

```
Server URL: https://your-agentgateway-endpoint.ts.net/mcp
```

The plugin provides a chatbot UI that talks to your server's obsidi-mcp. Your desktop Obsidian doesn't need the vault locally — the server handles everything.

## Security Considerations

- **Auth is not optional for production.** Without it, anyone who can reach the port can read/write your vault
- **Agentgateway provides audit logging** — every MCP call is logged with the agent identity. You'll want this
- **Rate limiting** prevents a runaway agent from flooding your vault with writes
- **Tailscale** means the MCP endpoint is never exposed to the public internet — only devices on your tailnet can reach it

## Troubleshooting

### MCP connection refused

- Verify obsidi-mcp is running: `docker compose exec obsidian obsidian --list-plugins`
- Check the plugin is enabled in Obsidian's settings
- Verify Agentgateway can reach the obsidian container (`docker compose exec agentgateway curl http://obsidian:3000`)

### Authentication errors

- Check Authelia logs: `docker compose logs authelia`
- Verify your Tailscale device is authorized on the tailnet
- Ensure the MCP client is sending credentials (bearer token or session cookie, depending on your auth config)

### Agent can't find notes

- Sync must be working first — if the vault is empty, there's nothing to read
- Check vault path inside the container: `docker compose exec obsidian ls /config/vaults/default/`

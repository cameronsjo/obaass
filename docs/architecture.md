# Architecture

## The Pattern

Obsidian is a desktop app. No server mode. No native API. No headless option. obaass runs it on a server anyway, because apparently that's how we spend our weekends now.

## the safe-ish stack

Three paths into one vault. Sync keeps it current, backup keeps it safe-ish, MCP lets the robots in.

```mermaid
graph TB
    subgraph clients["the humans and their various robots"]
        direction LR
        phone["Phone / iPad / Mac"]
        desktop["Desktop Obsidian<br/>w/ obsidi-claude"]
        claude_ai["Claude.ai"]
    end

    sync_cloud["Obsidian Sync Cloud"]

    subgraph auth["Auth and Ingress - optional, recommended"]
        direction LR
        ts["Tailscale Gateway"]
        proxy["Traefik + Authelia"]
        agw["Agentgateway"]
        ts --> proxy --> agw
    end

    subgraph server["the safe-ish stack"]
        subgraph headless["obsidi-headless"]
            obs_app["Obsidian App<br/>w/ Native Sync"]
            obs_mcp["obsidi-mcp plugin"]
        end
        backup["obsidi-backup"]
        vault["Vault"]
    end

    offsite["Offsite Storage<br/>just in case"]

    phone ---|sync| sync_cloud
    desktop ---|sync| sync_cloud
    sync_cloud ---|sync| obs_app

    claude_ai -- MCP --> ts
    desktop -. MCP .-> proxy
    agw -- MCP --> obs_mcp

    obs_app --> vault
    vault --> backup
    backup -- encrypted --> offsite
```

**Three paths, one vault:**

| Path | Route | What's happening |
|------|-------|------------------|
| **Sync** | Device <-> Obsidian Sync Cloud <-> obsidi-headless | Your phone edit shows up on the server in seconds. And vice versa. It's kind of magic |
| **Claude.ai** | Claude.ai -> Tailscale -> Agentgateway -> obsidi-mcp | An AI agent reading your grocery list. The future is now |
| **obsidi-claude** | Desktop plugin -> Traefik/Authelia -> Agentgateway -> obsidi-mcp | Chat with your vault from your laptop. The server does the thinking |

**Key distinction:** obsidi-claude is a chatbot plugin for the _desktop_ Obsidian app (the one with a screen). It connects to the _server's_ obsidi-mcp over the network through your auth layer. It does not run inside obsidi-headless. Two different plugins, two different machines, one vault.

## Backup Pipeline Detail

What happens when you change a file. Every time. Whether you asked for it or not.

```mermaid
graph TB
    subgraph bk["obsidi-backup"]
        direction LR
        watch["something<br/>changed"] --> debounce["wait for it..."]
        debounce --> commit["AI writes a<br/>commit message"]
        commit --> encrypt["encrypt +<br/>ship offsite"]
        encrypt --> notify["tell someone<br/>about it"]
    end

    vault["Vault"] --> watch
    encrypt --> offsite["Offsite Storage"]
```

inotify detects the change. Debounce waits for you to stop typing (5 minutes of quiet, configurable). Git commits with an AI-generated message that actually describes what changed instead of "updated files". Restic encrypts, deduplicates, and ships to offsite storage. Then it tells you about it. Retention: 7 daily, 4 weekly, 12 monthly snapshots. Your notes are probably safer than your tax documents.

## Container Architecture

For the people who want to see what's actually inside the boxes.

```mermaid
graph TB
    subgraph obaass["obaass stack"]
        direction TB

        subgraph obsidian["obsidi-headless"]
            xvfb["Xvfb :99<br/>the fakest display"]
            app["Obsidian App<br/>thinking it has a monitor"]
            sync["Obsidian Sync"]
            cli["Obsidian CLI"]
            mcp["obsidi-mcp plugin"]
            xvfb --> app
            app --> sync
            app --> cli
            app --> mcp
        end

        subgraph backup["obsidi-backup"]
            inotify["inotify watcher"]
            git["Git auto-commit"]
            ai["AI commit messages<br/>better than yours"]
            restic["Restic backup"]
            inotify --> git
            git --> ai
            git --> restic
        end

        vault["Shared Volume"]
        obsidian --> vault
        backup --> vault
    end

    cloud["Obsidian Sync Cloud"]
    sync ---|sync| cloud

    offsite["Offsite Storage"]
    restic -- encrypted --> offsite

    devices["Your Devices"]
    cloud ---|sync| devices
```

## Data Flow

Two scenarios. Both end with your notes backed up. That's the point.

```mermaid
sequenceDiagram
    participant D as Your Phone
    participant S as Obsidian Sync
    participant O as obsidi-headless
    participant V as Vault
    participant B as obsidi-backup
    participant R as Offsite Storage

    Note over D,R: you edit a note on your phone

    D->>S: Edit note
    S->>O: Sync it over
    O->>V: Write to disk
    V->>B: inotify fires
    Note over B: chill for 5 min
    B->>B: AI writes commit msg
    B->>R: Encrypt and ship

    Note over D,R: an AI writes a note

    O->>V: CLI writes note
    V->>B: inotify fires
    O->>S: Sync it out
    S->>D: Your phone gets it
    Note over B: chill for 5 min
    B->>B: AI writes commit msg
    B->>R: Encrypt and ship
```

## Compounding Capabilities

These three things work alone. Together they form a loop where everything reinforces everything else. It's the good kind of circular dependency.

```mermaid
graph LR
    A["AI Agent Access"] -->|writes trigger| B["Encrypted Backup"]
    A -->|writes trigger| C["Multi-Device Sync"]
    C -->|changes trigger| B
    B -->|restores trigger| C
    C -->|syncs trigger| A

    style A fill:#4a9eff,color:#fff
    style B fill:#ff6b6b,color:#fff
    style C fill:#51cf66,color:#fff
```

- AI writes a note -> Sync propagates to all devices -> Backup captures the change
- Phone edit -> Server receives via Sync -> Backup captures -> AI can read it
- Backup restores a file -> Sync propagates -> AI and all devices see it

## Why Xvfb?

Obsidian is an Electron app. Electron requires a display server — it will literally refuse to start without one. Xvfb (X Virtual Framebuffer) satisfies this requirement with a virtual display that renders to memory. Nothing is actually drawn. It's a display for an app with no eyes.

| Approach | Image Size | Overhead | GUI Access |
|----------|-----------|----------|------------|
| KasmVNC + XFCE (v1) | ~800MB+ | High — entire desktop environment for one app | Yes (browser) |
| **Xvfb only (v2)** | **~400MB** | **Minimal — just enough to trick Electron** | **No** |

v1 shipped an entire desktop environment just to run a single app. v2 strips all of that away. If you need a GUI, use a real device. The server is for Sync, CLI, and backup. It doesn't need to see.

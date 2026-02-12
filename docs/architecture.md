# Architecture

## The Pattern

Obsidian is a desktop app — no server mode, no native API, no headless option. OBaaSS runs it on a server anyway, unlocking three capabilities that compound.

## Container Architecture

```mermaid
graph TB
    subgraph OBaaSS["OBaaSS Stack (docker compose)"]
        direction TB

        subgraph obsidian["obsidian container"]
            xvfb["Xvfb :99<br/>(virtual display)"]
            app["Obsidian App<br/>(Electron)"]
            sync["Obsidian Sync<br/>(E2E encrypted)"]
            cli["Obsidian CLI<br/>(IPC socket)"]
            xvfb --> app
            app --> sync
            app --> cli
        end

        subgraph backup["backup container"]
            inotify["inotify watcher"]
            git["Git auto-commit"]
            ai["AI commit messages<br/>(Claude Haiku)"]
            restic["Restic backup<br/>(encrypted, deduped)"]
            inotify --> git
            git --> ai
            git --> restic
        end

        vault[("Shared Volume<br/>/vault")]
        obsidian --> vault
        backup --> vault
    end

    cloud["Obsidian Sync Cloud<br/>(E2E encrypted)"]
    sync <-->|"sync"| cloud

    offsite[("Offsite Storage<br/>(S3/Azure/B2)")]
    restic -->|"encrypted snapshots"| offsite

    devices["Devices<br/>(Mac, iPhone, iPad)"]
    cloud <-->|"sync"| devices
```

## Data Flow

```mermaid
sequenceDiagram
    participant D as Devices
    participant S as Obsidian Sync Cloud
    participant O as Obsidian (headless)
    participant V as Vault Volume
    participant B as Backup Sidecar
    participant R as Offsite Storage

    Note over D,R: Phone edit propagates everywhere

    D->>S: Edit note on iPhone
    S->>O: Sync change (E2E encrypted)
    O->>V: Write to filesystem
    V->>B: inotify event
    Note over B: Debounce (5 min)
    B->>B: Git commit (AI message)
    B->>R: Restic snapshot (encrypted)

    Note over D,R: AI agent writes to vault

    O->>V: CLI writes note
    V->>B: inotify event
    O->>S: Sync change
    S->>D: Propagate to devices
    Note over B: Debounce (5 min)
    B->>B: Git commit (AI message)
    B->>R: Restic snapshot (encrypted)
```

## Compounding Capabilities

```mermaid
graph LR
    A["AI Agent Access<br/>(CLI + MCP)"] -->|writes trigger| B["Encrypted Backup<br/>(git + restic)"]
    A -->|writes trigger| C["Multi-Device Sync<br/>(Obsidian Sync)"]
    C -->|changes trigger| B
    B -->|restores trigger| C
    C -->|syncs trigger| A

    style A fill:#4a9eff,color:#fff
    style B fill:#ff6b6b,color:#fff
    style C fill:#51cf66,color:#fff
```

Each capability works independently. Together they form a feedback loop:

- AI writes a note -> Sync propagates to all devices -> Backup captures the change
- Phone edit -> Server receives via Sync -> Backup captures -> AI can read it
- Backup restores a file -> Sync propagates -> AI and all devices see it

## Why Xvfb?

Obsidian is an Electron app. Electron requires a display server — it won't start without one. Xvfb (X Virtual Framebuffer) satisfies this requirement with a virtual display that renders to memory. Nothing is actually drawn; it's just enough to keep Electron happy.

| Approach | Image Size | Overhead | GUI Access |
|----------|-----------|----------|------------|
| KasmVNC + XFCE (v1) | ~800MB+ | High (VNC, WM, desktop) | Yes (browser) |
| **Xvfb only (v2)** | **~400MB** | **Minimal (framebuffer)** | **No** |

The v1 approach shipped an entire desktop environment just to run a single app. v2 strips that away — if you need a GUI, use a real device. The server is for Sync, CLI, and backup.

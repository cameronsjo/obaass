# Threat Model

**System:** obaass (Obsidian as-a Safe-ish Service)
**Method:** STRIDE per component + data flow analysis
**Date:** 2026-02-13
**Author:** Cameron Sjo + Claude

## System Overview

obaass runs the Obsidian desktop app headlessly on a server, creating three compounding capabilities: multi-device sync, encrypted backup, and AI agent access. This threat model covers the deployed stack and its interactions with external services.

### Assets

| Asset | Classification | Impact if Compromised |
|-------|---------------|----------------------|
| Vault contents (notes, attachments) | **Personal / Sensitive** | Full knowledge base exposure — personal notes, credentials in notes, private thoughts, project plans |
| Obsidian Sync credentials | **Secret** | Account takeover, sync to attacker-controlled vault |
| Obsidian Catalyst license | **Secret** | CLI access, license theft |
| Anthropic API key | **Secret** | Financial — unauthorized API usage |
| Restic repository password | **Secret** | Backup decryption, full vault history exposure |
| Discord webhook URL | **Sensitive** | Spam/phishing via trusted webhook |
| Git history | **Sensitive** | Full change history of vault, including deleted content |
| Container config volume | **Sensitive** | Obsidian state, credentials, plugin configs |

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────┐
│  Internet                                                │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐        │
│  │ Claude.ai│  │ Obsidian │  │ Client Devices │        │
│  │          │  │ Sync Cloud│  │ (phone/desktop)│        │
│  └────┬─────┘  └────┬─────┘  └───────┬────────┘        │
│       │              │                │                   │
├───────┼──────────────┼────────────────┼───── TB1: Network│
│       │              │                │                   │
│  ┌────▼─────┐        │          ┌─────▼──────┐          │
│  │ Tailscale│        │          │ Obsidian   │          │
│  │ Gateway  │        │          │ Sync (in   │          │
│  └────┬─────┘        │          │ container) │          │
│       │              │          └─────┬──────┘          │
├───────┼──────────────┼────────────────┼───── TB2: Auth   │
│       │              │                │                   │
│  ┌────▼──────────────┼───┐      ┌─────▼──────┐          │
│  │ Traefik + Authelia│   │      │ obsidi-    │          │
│  └────┬──────────────┘   │      │ headless   │          │
│       │                  │      └─────┬──────┘          │
│  ┌────▼─────┐            │            │                  │
│  │ Agent-   │            │      ┌─────▼──────┐          │
│  │ gateway  │            │      │   Vault    │ <-- TB3  │
│  └────┬─────┘            │      │  (shared   │          │
│       │                  │      │   volume)  │          │
│  ┌────▼─────┐            │      └─────┬──────┘          │
│  │ obsidi-  │            │            │                  │
│  │ mcp      │◄───────────┘      ┌─────▼──────┐          │
│  └──────────┘                   │ obsidi-    │          │
│                                 │ backup     │          │
│                                 └─────┬──────┘          │
│                                       │                  │
├───────────────────────────────────────┼───── TB4: Egress │
│                                       │                  │
│  ┌──────────────┐  ┌─────────────┐  ┌▼──────────┐      │
│  │ Anthropic API│  │ Discord     │  │ Offsite   │      │
│  │              │  │ Webhook     │  │ Storage   │      │
│  └──────────────┘  └─────────────┘  └───────────┘      │
└─────────────────────────────────────────────────────────┘
```

**TB1 — Network boundary:** Internet to Tailscale mesh. Untrusted traffic becomes tailnet-authenticated.
**TB2 — Auth boundary:** Tailscale to application layer. Authelia enforces identity.
**TB3 — Shared volume:** Both containers (obsidi-headless, obsidi-backup) have read/write access to the vault.
**TB4 — Egress boundary:** Server to external services (Anthropic, Discord, offsite storage).

---

## STRIDE Analysis by Component

### 1. obsidi-headless

The Electron app running under Xvfb with Sync, CLI, and obsidi-mcp plugin.

| Threat | Category | Severity | Description |
|--------|----------|----------|-------------|
| TH-1 | **Spoofing** | High | Obsidian Sync credentials stored in the Docker volume. If the volume is exposed (misconfigured mount, backup of /config), attacker gains Sync access to all devices |
| TH-2 | **Tampering** | Critical | obsidi-mcp provides read/write vault access. A compromised or malicious MCP client can modify any note, inject content, or delete files |
| TH-3 | **Information Disclosure** | High | The full vault is readable via MCP. No per-note ACLs. An agent with MCP access reads everything — personal notes, credentials stored in notes, private journals |
| TH-4 | **Elevation of Privilege** | Medium | Obsidian CLI communicates via IPC socket (`/tmp/obsidian-ipc.sock`). If another process in the container (or a shared PID namespace) accesses this socket, it gains full CLI control |
| TH-5 | **Tampering** | Medium | Electron app with Xvfb — if the container runs as root, a vulnerability in Obsidian or its plugins could lead to container escape |
| TH-6 | **Information Disclosure** | Medium | Obsidian community plugins (including obsidi-mcp) run with full app privileges. A supply chain compromise of any installed plugin exposes the vault and Sync credentials |

### 2. obsidi-backup

Filesystem watcher, git, AI commit messages, restic, notifications.

| Threat | Category | Severity | Description |
|--------|----------|----------|-------------|
| TB-1 | **Information Disclosure** | High | Vault diffs are sent to Anthropic API for commit message generation. Note contents cross TB4 to a third-party LLM. Sensitive content in notes (passwords, personal info, health data) gets sent to Anthropic |
| TB-2 | **Information Disclosure** | Medium | Git history contains the full evolution of every note. If the git repo is exposed (misconfigured volume, pushed to a public remote), the entire vault history leaks — including content that was "deleted" |
| TB-3 | **Spoofing** | Medium | Discord webhook URL allows anyone with the URL to post messages impersonating the backup system. Webhook URLs are bearer credentials |
| TB-4 | **Denial of Service** | Low | A flood of filesystem changes (sync storm, runaway agent writes) triggers continuous inotify events. Debounce mitigates this, but rapid changes could cause CPU/IO pressure or git history bloat |
| TB-5 | **Tampering** | Medium | Restic repository password in environment variable. If the offsite storage credentials leak, an attacker can modify or destroy backups — removing the safety net |
| TB-6 | **Information Disclosure** | Medium | AI-generated commit messages may summarize sensitive content. Git log becomes a readable index of vault changes even without accessing the notes themselves |

### 3. Shared Vault Volume

The Docker volume mounted read/write by both containers.

| Threat | Category | Severity | Description |
|--------|----------|----------|-------------|
| TV-1 | **Tampering** | High | Both containers have unrestricted write access. A compromised obsidi-backup could inject content into the vault that then syncs to all devices |
| TV-2 | **Denial of Service** | Medium | No filesystem quotas. A runaway process (or malicious agent via MCP) can fill the volume, crashing both containers |
| TV-3 | **Tampering** | Medium | Race condition between Sync writes and backup reads. File observed mid-write could produce corrupted git commits. Not a security issue per se, but could mask tampering |

### 4. Auth Layer (Tailscale + Traefik + Authelia + Agentgateway)

| Threat | Category | Severity | Description |
|--------|----------|----------|-------------|
| TA-1 | **Spoofing** | Critical | Auth layer is marked "optional, recommended." If deployed without auth, obsidi-mcp is exposed directly — anyone who can reach the port has full vault read/write |
| TA-2 | **Spoofing** | High | Agentgateway sits between auth and MCP. If Agentgateway trusts headers (e.g., `X-Forwarded-User`) without validating the source, an attacker bypassing Traefik can spoof identity |
| TA-3 | **Repudiation** | Medium | Without Agentgateway's audit logging, there's no record of which agent made which vault change. A rogue agent (or compromised MCP client) can modify notes with no attribution |
| TA-4 | **Elevation of Privilege** | Medium | Tailscale device authorization is all-or-nothing for the tailnet. Any compromised device on the tailnet can reach the obaass services |
| TA-5 | **Information Disclosure** | Medium | If Authelia session tokens are not properly scoped or expire, a stolen session grants persistent vault access |

### 5. Obsidian Sync Cloud (Third-Party)

| Threat | Category | Severity | Description |
|--------|----------|----------|-------------|
| TS-1 | **Information Disclosure** | Medium | Vault contents transit through Obsidian's relay servers. Obsidian claims end-to-end encryption, but the encryption key management is opaque — you trust Obsidian's implementation |
| TS-2 | **Tampering** | Medium | A compromise of Obsidian's Sync infrastructure could push malicious content to your vault. This syncs to the server, which syncs to all devices and gets backed up |
| TS-3 | **Denial of Service** | Low | Obsidian Sync outage prevents multi-device propagation. Vault on server is still functional but isolated |

### 6. External Services (Anthropic API, Discord, Offsite Storage)

| Threat | Category | Severity | Description |
|--------|----------|----------|-------------|
| TE-1 | **Information Disclosure** | High | Anthropic API receives vault diffs. No filtering of sensitive content before transmission. The diff could contain credentials, personal health info, financial data, or anything else in your notes |
| TE-2 | **Denial of Service** | Low | Anthropic API outage causes commit message fallback to timestamp. Not a security issue, but degrades auditability |
| TE-3 | **Spoofing** | Low | Discord webhook is a static URL. If leaked, anyone can send fake backup notifications, potentially as a social engineering vector ("Your vault backup failed — click here to fix") |

---

## Attack Scenarios

### Scenario 1: Rogue AI Agent (Critical)

**Path:** Compromised MCP client -> Agentgateway -> obsidi-mcp -> vault

An attacker compromises an MCP client (or a user misconfigures Claude.ai to point at the wrong MCP server). The agent has full vault read/write. It can:

1. **Exfiltrate** the entire vault contents note by note
2. **Inject** content into notes that sync to all devices (phishing links, misinformation, malicious Obsidian plugin configs)
3. **Delete** notes, which Sync propagates everywhere and backup dutifully commits as "deleted files"

**Mitigations:**
- Agentgateway rate limiting and audit logging (detect anomalous read/write patterns)
- Authelia authentication per agent identity
- Consider read-only MCP mode for untrusted agents
- Implement per-path ACLs in obsidi-mcp (e.g., deny writes to system directories)

### Scenario 2: Vault Content Exfiltration via Commit Messages (High)

**Path:** Vault change -> obsidi-backup -> Anthropic API

Every vault change sends a diff to Anthropic for commit message generation. The diff contains the actual note content. If notes contain passwords, API keys, health records, legal documents, or personal journal entries, all of that transits to Anthropic.

**Mitigations:**
- Implement a content filter before sending diffs to Anthropic (strip known secret patterns, limit diff size)
- Use local models for commit message generation (Ollama, llama.cpp) to keep content on-premises
- Make AI commit messages opt-in rather than opt-in-by-default with an API key
- Add a `COMMIT_MSG_REDACT_PATTERNS` config for regex-based redaction

### Scenario 3: Auth Layer Bypass (Critical)

**Path:** Internet -> obsidi-mcp (no auth)

The docker-compose.yml ships with no auth layer. The MCP integration docs say auth is "optional, recommended." A user who exposes the obsidi-mcp port (or runs on a shared network) without auth gives anyone full vault access.

**Mitigations:**
- obsidi-mcp SHOULD bind to localhost only by default
- docker-compose.yml SHOULD NOT expose ports without auth
- Add a startup check: if no auth token is configured, refuse to start (or log a warning every 60 seconds)
- Document the "no auth" configuration as explicitly insecure

### Scenario 4: Supply Chain — Obsidian Plugin Compromise (High)

**Path:** Malicious plugin update -> obsidi-headless -> vault + Sync credentials

obsidi-mcp runs as an Obsidian community plugin inside the headless container. Community plugins have full app privileges. A compromised plugin (supply chain attack on obsidi-mcp or any other installed plugin) can:

1. Read Sync credentials and exfiltrate them
2. Read/modify vault contents
3. Open network connections from within the container

**Mitigations:**
- Pin plugin versions — never auto-update in the headless container
- Use volume mounts for plugins (auditable, versioned)
- Run the container with minimal network egress (only allow Obsidian Sync endpoints, Agentgateway)
- Container network policy: deny-all egress, allow-list specific destinations

### Scenario 5: Backup Destruction (High)

**Path:** Leaked restic password + repo URL -> attacker modifies/deletes offsite backups

Restic password and repository URL are environment variables. If either leaks (docker inspect, process listing, `.env` committed to git), an attacker can:

1. Decrypt and read the entire vault history
2. Delete or corrupt backup snapshots
3. Modify backups to inject content (though restic's integrity checks make this harder)

**Mitigations:**
- Use Docker secrets or a secrets manager instead of environment variables for `RESTIC_PASSWORD`
- Enable restic repository lock/append-only mode on the storage backend
- Use separate credentials for backup write vs. read (if the storage backend supports it)
- Monitor for unexpected restic operations on the storage backend

---

## Risk Matrix

| ID | Threat | Likelihood | Impact | Risk | Status |
|----|--------|-----------|--------|------|--------|
| TA-1 | No auth on MCP endpoint | **High** | **Critical** | **Critical** | Open — docker-compose ships without auth |
| TH-2 | MCP client full vault write | **Medium** | **Critical** | **High** | Open — no write restrictions in MCP |
| TB-1 / TE-1 | Vault diffs sent to Anthropic | **High** | **High** | **High** | Open — no content filtering |
| TH-3 | MCP client reads all notes | **Medium** | **High** | **High** | Open — no per-note ACLs |
| TH-1 | Sync credentials in volume | **Low** | **High** | **Medium** | Accepted — standard Docker volume model |
| TB-5 | Restic password in env var | **Medium** | **High** | **High** | Open — use Docker secrets |
| TH-6 | Plugin supply chain | **Low** | **High** | **Medium** | Open — pin versions, audit plugins |
| TV-1 | Shared volume tampering | **Low** | **High** | **Medium** | Accepted — architectural trade-off |
| TB-6 | Commit messages leak content | **High** | **Medium** | **Medium** | Open — inherent to AI summarization |
| TA-4 | Tailnet device compromise | **Low** | **High** | **Medium** | Accepted — Tailscale's threat model |
| TS-1 | Sync cloud trust | **Low** | **High** | **Medium** | Accepted — Obsidian's E2E encryption claim |
| TB-3 / TE-3 | Discord webhook spoofing | **Low** | **Low** | **Low** | Accepted |
| TB-4 / TV-2 | DoS via write flood | **Low** | **Medium** | **Low** | Mitigated by debounce |

*Higher likelihood and higher impact produce higher risk.*

---

## Recommended Mitigations (Priority Order)

### P0 — Do Before Deploying

1. **Bind obsidi-mcp to localhost** — the docker-compose MUST NOT expose MCP ports to the network without auth in front
2. **Add content filtering before Anthropic API calls** — at minimum, strip lines matching common secret patterns (`password`, `api_key`, `token`, `Bearer`, etc.) from diffs before sending
3. **Document the "no auth" risk** prominently in README, not buried in docs/mcp-integration.md

### P1 — Do Before Sharing with Others

4. **Implement MCP authentication** — obsidi-mcp SHOULD require a bearer token even behind Agentgateway (defense in depth)
5. **Move secrets to Docker secrets** — `RESTIC_PASSWORD` and `ANTHROPIC_API_KEY` should not be plain env vars
6. **Pin plugin versions** in the headless container — no auto-updates
7. **Add MCP write-mode configuration** — allow read-only mode for untrusted agents

### P2 — Hardening

8. **Run containers as non-root** — verify obsidi-headless doesn't require root
9. **Network policies** — restrict container egress to known destinations
10. **Restic append-only mode** — prevent backup deletion even with leaked credentials
11. **MCP rate limiting** — configure Agentgateway to limit reads/writes per minute
12. **Audit logging** — ensure every MCP operation is logged with agent identity and timestamp

### P3 — Future Considerations

13. **Per-path ACLs in obsidi-mcp** — deny writes to `.obsidian/` config directory, restrict access to specific folders
14. **Local LLM for commit messages** — eliminate the Anthropic API data flow entirely
15. **Vault content classification** — tag notes with sensitivity levels, enforce access based on classification
16. **Backup integrity monitoring** — alert on unexpected restic operations or missing snapshots

---

## Assumptions

- Obsidian Sync's end-to-end encryption is correctly implemented (not independently verified)
- Tailscale's mesh network correctly authenticates devices
- The deployer's host OS and Docker runtime are not compromised
- Obsidian's IPC socket is only accessible within the container
- The deployer reads the documentation before exposing services to any network

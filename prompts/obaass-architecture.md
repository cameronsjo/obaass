---
name: obaass-architecture
aspect_ratio: '9:16'
resolution: 4K
style: modern-tech-illustration
last_generated: null
last_updated: '2026-02-12T03:21:00Z'
---

### Subject

A vertical system architecture diagram rendered as a clean, modern technical illustration. Five horizontal bands stack top-to-bottom within the tall frame, each representing a layer of infrastructure: client devices at the top, a sync cloud relay just below, an authentication gateway across the middle, a server stack occupying the largest central area, and offsite storage at the bottom. Three types of flowing connections weave between the layers — blue streams for sync, amber streams for MCP agent access, and teal streams for encrypted backup — creating a visual tapestry of data movement that is the primary focal point of the composition.

### Environment

A very pale warm gray background, barely distinguishable from white, provides a neutral canvas. Each of the five bands sits on a slightly elevated rounded-rectangle platform with the faintest drop shadow, giving the layers a subtle card-like dimensionality without breaking the flat aesthetic. Generous white space separates each band — approximately thirty percent of the vertical space is breathing room between layers. The overall composition reads as a single coherent diagram, not five separate illustrations, because the flowing connection lines bridge every gap and tie the layers together.

### Top Band — Client Devices

Three device silhouettes are arranged in a horizontal row across the upper portion of the frame. On the left, a smartphone and tablet stacked at a slight angle, rendered as simple rounded rectangles with minimal screen detail — representing phones, iPads, and Macs. In the center, a laptop silhouette with a small diamond-shaped Obsidian logo glow on its screen, representing the desktop app with the obsidi-claude plugin. On the right, a softly glowing orb with a warm amber core, representing Claude.ai — distinct from the devices, clearly an AI agent rather than a human's tool. Each device is rendered in cool slate gray with subtle surface highlights. The amber orb is the only warm-colored element in this band, drawing attention to the AI entry point.

### Upper Band — Sync Cloud

A horizontal cloud shape with soft, rounded edges floats between the client tier and the auth layer. The cloud is rendered in a pale blue with a gentle inner glow, suggesting an always-on relay. Two blue flowing streams descend from the phone cluster and the laptop, curving gently inward to enter the cloud from above. A single blue stream exits the cloud downward, passing through the auth layer and continuing into the server stack below. These blue streams have a soft luminous quality — slightly wider than a simple line, with a subtle gradient from lighter at the edges to saturated blue at the center, like fiber optic light guides.

### Middle Band — Auth and Ingress

A horizontal strip spanning the full width of the frame, rendered in darker slate with a matte finish — visually distinct from the lighter layers above and below, suggesting a security boundary. Three small component badges sit in a row within this strip: a shield icon on the left for the Tailscale gateway, a lock-and-route icon in the center for Traefik with Authelia, and a bridge icon on the right for Agentgateway. Thin white connector lines link the three badges left-to-right, showing their chain relationship. The amber MCP stream from Claude.ai above enters this strip from the upper-right, passes through all three badges sequentially, and exits downward toward the server. A second, thinner amber stream enters from the laptop (the desktop plugin's MCP path), merging with the main stream at the Traefik badge. The auth strip acts as a visual chokepoint — everything entering from above must pass through this narrow, darker band.

### Lower Band — The Server Stack

The largest visual element, occupying roughly a third of the total frame height. A rounded-rectangle platform in warm off-white contains three nested elements. On the left side, a larger sub-card labeled by a subtle purple border houses the obsidi-headless container: within it, two smaller shapes — a purple rounded square for the Obsidian app with sync capability, and below it a smaller amber-accented square for the obsidi-mcp plugin. The blue sync stream from the cloud above terminates at the purple Obsidian app square. The amber MCP stream from the auth layer terminates at the amber-accented mcp square. On the right side of the platform, a teal-bordered sub-card represents obsidi-backup, with a small circular icon suggesting a watcher eye. Between the headless container and the backup container, centered at the bottom of the platform, sits the vault — rendered as a prominent rounded hexagon in deep purple with a soft inner glow, the visual heart of the entire diagram. Subtle connection lines radiate from the vault to both the headless container and the backup container, showing the shared volume relationship.

### Bottom — Offsite Storage

Below the server platform, a single teal flowing stream descends from the backup container, passing through a small padlock icon mid-stream to indicate encryption, and terminates at a simple storage icon at the very bottom of the frame — a rounded rectangle with horizontal lines suggesting layered snapshots. The storage icon is rendered in muted teal with a cool shadow, grounding the entire composition.

### Lighting

No directional light source — this is a flat illustration, not a scene. Instead, luminosity comes from the flowing data streams themselves. The blue sync streams emit a soft azure glow that tints nearby surfaces. The amber MCP streams cast a warm halo where they pass through the auth layer. The teal backup stream has a cooler, steadier glow. The vault hexagon at the center of the server stack has the strongest inner glow — a deep purple luminescence that subtly radiates outward, marking it as the gravitational center of the entire system. All other surfaces are matte and neutral, allowing the colored streams to dominate visually.

### Style

Modern flat technical illustration in the style of premium developer documentation — clean geometric shapes, generous whitespace, minimal detail per element, and a confident restraint that lets the data flows tell the story. The palette is tightly constrained to five colors with assigned roles: deep purple for the Obsidian vault and app elements, cool azure blue for sync flow streams, warm amber for MCP agent access streams, muted teal for backup and encryption streams, and neutral slate gray for infrastructure and device silhouettes. The background is barely-there warm gray. Shapes use consistent corner radii and subtle one-pixel borders rather than heavy outlines. The flowing streams are the only organic forms in an otherwise geometric composition — they curve gently, slightly wider than technical diagram lines, with soft luminous edges that make them feel alive against the static architecture. The mood is calm, assured, and modern — infrastructure that works quietly and well, rendered with the visual confidence of a system that knows exactly what it does.

No text anywhere in the image.

# Changelog

## Unreleased

- Reject idle event subscriptions because this service publishes no events;
  expose the real-process SDK smoke probe as `npm run test:smoke`.

- Match `backup_status` to the sidecar’s actual `/health` response; preserve
  unknown fields and tolerate absent optional uptime across sidecar versions.

- Upgrade to the official MCP v2 SDK (server/client 2.3.1, Node adapter 2.1.1).
  HTTP supports protocol 2026-07-28 through a fresh server per request and keeps
  older clients working through the SDK's stateless compatibility handler.

- JSON-returning tools advertise an MCP `outputSchema` and return validated
  `structuredContent` alongside their existing JSON text. `vault_structure` uses
  `{ entries: [...] }` and `recent_files` uses `{ files: [...] }` for the structured
  object; their text fallbacks remain arrays. Other JSON tools keep the same
  object shape in both representations.

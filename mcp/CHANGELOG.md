# Changelog

## Unreleased

- Refresh the security dependency group and align Vitest/coverage-v8 at 5.0.4
  so clean installs no longer fail peer resolution. Development now requires
  Node 22.12+, 24, or 26+ as supported by Vitest 5; coverage floors are unchanged.

- Await asynchronous MCP cleanup before successful process exit, while HTTP
  shutdown starts concurrently and the existing ten-second timeout remains.

- Validate HTTP Host and Origin with the SDK before parsing or dispatch; default
  to loopback at the configured port. `MCP_ALLOWED_HOSTS` explicitly permits
  additional LAN/Tailscale endpoints or HTTPS proxy origins. Existing remote
  clients must opt in; mismatched hosts, schemes or ports now receive 403.

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

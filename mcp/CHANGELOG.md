# Changelog

## Unreleased

- Match `backup_status` to the sidecar's actual `/health` response; preserve
  unknown fields and tolerate absent optional uptime across sidecar versions.

- JSON-returning tools advertise an MCP `outputSchema` and return validated
  `structuredContent` alongside their existing JSON text. `vault_structure` uses
  `{ entries: [...] }` and `recent_files` uses `{ files: [...] }` for the structured
  object; their text fallbacks remain arrays. Other JSON tools keep the same
  object shape in both representations.

# Changelog

## Unreleased

- JSON-returning tools advertise an MCP `outputSchema` and return validated
  `structuredContent` alongside their existing JSON text. `vault_structure` uses
  `{ entries: [...] }` and `recent_files` uses `{ files: [...] }` for the structured
  object; their text fallbacks remain arrays. Other JSON tools keep the same
  object shape in both representations.

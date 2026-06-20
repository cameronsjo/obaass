# MCP Specification: Resources, Templates, and Adoption Roadmap for obaass-mcp

**Date:** 2026-06-05  
**Question:** What is new in the latest MCP specification, and what resources/templates features are adoptable for a self-hosted HTTP MCP server exposing an Obsidian vault?

## Answer

The MCP protocol reached version **2025-11-25** (released 2025-11-25) and introduced **Elicitation** (form and URL modes for user input) and **Completions** (autocomplete for resource/prompt arguments). The vault server should adopt **Resource Templates** (RFC 6570 URI templates with parameters like `obsidian://{+path}`) for dynamic note discovery, **Completions** for note-path autocompletion, **resource_links in tool results** to let tools return structured references to vault notes, and **outputSchema on tools** to validate structured outputs. **Elicitation** and **Sampling** are stable but optional—worth deferring unless the server needs to gather user input or invoke LLM logic.

## Evidence

- [MCP Specification 2025-11-25 Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) — URI templates using RFC 6570, custom schemes via RFC 3986, resource metadata with annotations, subscriptions/listChanged notifications
- [MCP Specification 2025-11-25 Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — outputSchema for structured results, resource_links and embedded resources, tool annotations
- [MCP Specification 2025-11-25 Completions](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion) — completion/complete protocol for resource templates and prompts, fuzzy matching, pagination
- [MCP Specification 2025-11-25 Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) — Form and URL modes for requesting user info; new in 2025-11-25
- [MCP Specification 2025-11-25 Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) — Capability negotiation showing all server/client features
- [TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk) — v1.x stable; v2 alpha (Resources, ResourceTemplate, Completions supported in both)

## Detailed Findings

### 1. Latest Protocol Revision and Notable Changes

**Version:** `2025-11-25`  
**Previous:** `2024-11-05` (implied by v2025 release date)

**Key additions in 2025-11-25:**
- **Elicitation** (client capability): Form and URL modes for servers to request user information (`elicitation/create` method). URL mode is critical for OAuth/sensitive flows without exposing data through the client.
- **Tasks** (utility): Task-augmented execution with server-initiated requests
- **Completions** (utility): Formalized completion protocol for arguments to prompts and resource templates
- **Sampling tools support**: Servers can now request LLM generations that include tool use (agentic loops)
- **Resource annotations**: `lastModified`, `audience` (user/assistant), `priority` (0–1) for better context management

**Relevant to file/document servers:**
- Resource Templates with RFC 6570 allow parameterized access (e.g., `vault://{+path}`)
- Completions enable autocomplete for note paths
- Annotations let clients prioritize vault resources for context inclusion
- resource_links in tool results provide first-class linking between tools and resources

### 2. Resources and Resource Templates

**URI Identification:**
- Resources are identified by **RFC 3986-compliant URIs** (scheme, authority, path, query, fragment)
- Common schemes: `file://`, `https://`, `git://`, or custom (must be RFC 3986-compliant)
- For Obsidian vault: `obsidian://{+path}` or `vault://{+path}` are valid custom schemes

**Resource Templates (RFC 6570):**
- **Syntax:** `"uriTemplate": "vault://{+path}"` (RFC 6570 is the standard for URI templates in HTTP APIs; see [RFC 6570](https://datatracker.ietf.org/doc/html/rfc6570))
- **Variables:** `{path}`, `{+path}` (reserved expansion, allows `/` without percent-encoding), `{?query}`, etc.
- **Parameter types:** Can be simple or reserved. The `+` operator in `{+path}` is crucial for paths with `/` characters (e.g., `folder/note.md`)
- **Listing vs. Reading:**
  - Clients send `resources/templates/list` to discover all templates
  - Clients send `resources/read` with a concrete URI (e.g., `vault:///folder/note.md`) to fetch
  - Servers optionally provide a `list` callback for each template to enumerate available resources
- **Spec requirement on URIs:** Must satisfy RFC 3986. Percent-encoding is **required for special characters** in the path component unless using `{+path}` expansion

**Practical for obaass-mcp:**
```json
{
  "uriTemplate": "obsidian://{+path}",
  "name": "Vault Note",
  "title": "Obsidian Vault Notes",
  "description": "Access markdown files in the vault",
  "mimeType": "text/markdown"
}
```

When a client calls `resources/read { "uri": "obsidian:///folder/note.md" }`, the server's handler receives `{path: "folder/note.md"}` after RFC 6570 parameter extraction.

### 3. resource_links in Tool Results

**Yes**, tools can return links to resources:
```json
{
  "type": "resource_link",
  "uri": "obsidian:///folder/note.md",
  "name": "folder/note.md",
  "description": "Vault note",
  "mimeType": "text/markdown"
}
```

**Use case:** A tool like `search_vault` returns multiple resource_links to matching notes, allowing clients to:
- Fetch the full content via `resources/read`
- Display them in a picker or navigator
- Not guaranteed to appear in `resources/list`, but discoverable via tool invocation

**Distinction from embedded resources:**
- `resource_link`: Reference (URI + metadata) — client must fetch
- `resource` (embedded): Full content inline in tool result

**Recommendation:** Use resource_links for search/filter tools, embedded resources for small metadata/summaries.

### 4. Completions / Autocomplete for Resource Templates

**Protocol:** `completion/complete` request specifies a reference type and argument being completed

**Request example for resource template argument:**
```json
{
  "method": "completion/complete",
  "params": {
    "ref": {
      "type": "ref/resource",
      "uri": "obsidian://{+path}"
    },
    "argument": {
      "name": "path",
      "value": "fold"
    }
  }
}
```

**Response (up to 100 suggestions):**
```json
{
  "result": {
    "completion": {
      "values": ["folder/note1.md", "folder/note2.md"],
      "total": 15,
      "hasMore": true
    }
  }
}
```

**Server-side:**
- Implement a completion handler for the resource template
- Filter vault paths by the `value` prefix (fuzzy matching is recommended)
- Return ranked results

**TypeScript SDK v1:** `server.registerResource()` accepts a resource template with a `list()` callback; completion may be exposed via a separate completions registration (check v1 docs for exact API).

### 5. Structured Tool Output (outputSchema)

**Protocol:** Tools declare an `outputSchema` (JSON Schema) alongside `inputSchema`

**Example:**
```json
{
  "name": "get_note_metadata",
  "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } },
  "outputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" },
      "created": { "type": "string", "format": "date-time" },
      "wordCount": { "type": "integer" }
    }
  }
}
```

**Tool result:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"path\": \"folder/note.md\", \"created\": \"2025-06-05T10:00:00Z\", \"wordCount\": 240}"
    }
  ],
  "structuredContent": {
    "path": "folder/note.md",
    "created": "2025-06-05T10:00:00Z",
    "wordCount": 240
  }
}
```

**Benefits:**
- Clients and LLMs validate outputs against schema
- Better tooling/documentation
- Enables stricter integration paths

**Status:** Stable, already widely used. Worth adopting for obaass-mcp tools like `get_note_metadata`, `list_notes_in_folder`.

### 6. Elicitation and Sampling (Stable but Optional for obaass)

**Elicitation:**
- **Form mode:** Servers request structured user input (name, email, multiselect) via `elicitation/create { mode: "form", requestedSchema: {...} }`
- **URL mode:** Servers redirect users to a sensitive URL (OAuth, payment, API key entry) without exposing data to the client — `elicitation/create { mode: "url", url: "...", elicitationId: "..." }`
- **Status:** New in 2025-11-25, stable; optional for vault servers unless you need user configuration/secrets

**Sampling:**
- Servers invoke LLM generations (call Claude, GPT, etc.) through the client
- Includes tool-use support: LLM can invoke tools, receive results, continue reasoning
- **Status:** Stable; optional for vault servers unless you want agentic search or AI-assisted note operations

**For obaass:** Skip these initially. They're valuable if you want Claude to autonomously search/analyze the vault, but not essential for exposing vault as a resource/tool interface.

### 7. Handling Vault Paths with `/`, Spaces, and `#`

**The challenge:** Obsidian note paths like `folder/subfolder/my note #1.md` contain special characters

**RFC 6570 solution (recommended):**
- Use `{+path}` (reserved expansion) in the URI template
- RFC 6570 does NOT percent-encode `/` in reserved expansions, but DOES encode other special chars
- Example: `vault://{+path}` with path `folder/my note.md` → URI is `vault://folder/my%20note.md` (space encoded, `/` preserved)

**Spec requirement:**
- The final URI **MUST** be RFC 3986-compliant
- Special characters outside the unreserved set (A–Z, a–z, 0–9, `-`, `.`, `_`, `~`) MUST be percent-encoded
- The `{+path}` expansion handles this encoding automatically if you pass the raw path to the template expansion library

**TypeScript SDK (v1):**
When you call `server.registerResource(template, ...)` with `uriTemplate: "vault://{+path}"`, the SDK's URI template expansion (likely using a lib like `uritemplates` or `rfc6570`) will:
1. Take the input parameter `{path: "folder/my note #1.md"}`
2. Apply RFC 6570 expansion rules: `#` → `%23`, space → `%20`, `/` → `/` (reserved)
3. Return `vault://folder/my%20note%20%231.md`

**Client-side interop:** Clients that receive the URI `vault://folder/my%20note%20%231.md` must percent-decode the path component before passing to the server's handler. The SDK typically handles this transparently.

**Known interop gotchas:**
- Some clients may not correctly handle custom schemes with percent-encoded paths — test with Claude/VS Code clients
- Double-encoding can occur if both client and server percent-encode — ensure only one layer of encoding
- Fragment identifiers (`#` in URIs) have special meaning in RFC 3986 (they're post-authority, not part of the path) — use `%23` in the path component

**Safe pattern for obaass-mcp:**
```typescript
// Server: register with {+path} to preserve slashes
server.registerResource(
  'vault-note',
  new ResourceTemplate('obsidian://{+path}', {
    list: async () => {
      // List all vault notes: return URIs like obsidian://folder/note.md
    }
  }),
  { description: 'Obsidian vault notes' },
  async (uri, { path }) => {
    // uri is "obsidian://folder/my%20note.md"
    // path is "folder/my note.md" (decoded by SDK)
    // Read file at path
  }
);
```

## Caveats

1. **Version fragmentation:** v1.x is stable; v2 (alpha) has breaking API changes. obaass currently uses v1.29.x — most features mentioned here are backported to v1 or planned for v2. Verify exact API surface in v1 docs before coding.

2. **Completions API:** The TypeScript SDK's API for registering completions may differ between v1 and v2. v1 docs recommend wrapping arguments with `completable()` in tool schemas; v2 may have a separate `registerCompletion()` method. Check current SDK docs.

3. **Resource Templates with custom schemes:** Not all MCP clients support custom URI schemes. Test with Claude, VS Code Copilot, and Cursor to ensure `obsidian://` or `vault://` URIs are handled correctly. Fallback to `file://` if custom schemes cause issues.

4. **Percent-encoding edge cases:** Path components with `#` must be encoded as `%23` to avoid confusing the URI parser (which treats `#` as the fragment delimiter). Slashes in folder names are rare in Obsidian but must be percent-encoded as `%2F` if they occur.

5. **Elicitation/Sampling adoption:** These are new (2025-11-25 for Elicitation) and require client support. Not all MCP clients have implemented them yet. Verify before building server-initiated flows.

6. **Resource subscriptions:** The spec allows servers to declare `subscribe: true` in the resources capability, enabling clients to subscribe to individual resource change notifications. This is complex; defer until use case is clear.

## Recommendations: Adoption Roadmap for obaass-mcp

### Phase 1 (Immediate: v1.x, next 1-2 sprints)

1. **Convert tools to use `outputSchema`**
   - Adds validation without breaking existing clients
   - Example: `read_note` → `outputSchema: { type: "object", properties: { content: { type: "string" }, frontmatter: { type: "object" } } }`
   - Effort: Low; improves integration quality

2. **Add `resource_links` to search/filter tools**
   - `search_content` returns `resource_link` objects instead of inline text
   - Clients can fetch full content or display in a navigator
   - Effort: Low; improves UX for Claude and other smart clients

3. **Implement basic Resource Template**
   - URI: `obsidian://{+path}` or stick with `file://`
   - No list callback initially; just support read
   - Effort: Medium; unblocks dynamic note access

### Phase 2 (Short-term: v1.x, next 2-3 sprints)

4. **Add Completions for resource template paths**
   - Let clients autocomplete note paths as users type
   - Use fuzzy matching against vault index
   - Effort: Medium; requires vault walking/caching

5. **Annotations on resources**
   - Tag high-priority notes with `priority: 0.9`
   - Set `audience: ["assistant"]` for notes meant for AI analysis only
   - Effort: Low; improves client heuristics

### Phase 3 (Medium-term: v2 when stable, Q3 2026)

6. **Upgrade to v2 SDK**
   - Cleaner API surface, better composability
   - Evaluate breaking changes in resource/tool registration
   - Effort: High; full test/deploy cycle

7. **Evaluate Elicitation for vault config**
   - URL mode: Link to a web UI for vault auth/secrets
   - Form mode: Request vault encryption key if needed
   - Effort: Medium; only if vault requires interactive setup

8. **Sampling for AI-driven operations (optional)**
   - Let servers invoke Claude to generate tags, summarize notes
   - Requires careful UX design (user approval flow)
   - Effort: High; defer unless strong use case

### What NOT to do

- **Don't expose vault paths in URIs without encoding** — always percent-encode special chars
- **Don't assume all clients handle custom URI schemes** — test and fall back to `file://` if needed
- **Don't use form-mode Elicitation for secrets** — use URL mode or out-of-band auth
- **Don't implement subscriptions without a clear use case** — high complexity for vault-as-a-service

## Summary

The 2025-11-25 MCP spec is production-ready for vault servers. **Adopt immediately:** outputSchema, resource_links, basic Resource Templates. **Adopt next:** Completions, annotations. **Defer:** Elicitation and Sampling unless you need user interaction or agentic loops. Use RFC 6570 with `{+path}` for paths with slashes, and always percent-encode special characters. Test with real clients (Claude, VS Code) before shipping custom URI schemes.

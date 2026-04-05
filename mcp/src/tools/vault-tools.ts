import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition, ToolProvider } from "./types.js";
import type { VaultService } from "../vault/vault-service.js";
import { updateFrontmatter, extractTags } from "../vault/frontmatter.js";
import type { Config } from "../config.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export class VaultToolProvider implements ToolProvider {
  id = "vault";
  name = "Vault Tools";

  constructor(
    private vault: VaultService,
    private config: Config,
  ) {}

  getTools(): ToolDefinition[] {
    return [
      this.readNote(),
      this.createNote(),
      this.appendToNote(),
      this.deleteNote(),
      this.searchContent(),
      this.vaultStructure(),
      this.fileMetadata(),
      this.vaultTags(),
      this.searchByTag(),
      this.searchByProperty(),
      this.recentFiles(),
      this.setFrontmatter(),
      this.renameFile(),
      this.dailyNote(),
      this.getInstructions(),
    ];
  }

  private readNote(): ToolDefinition {
    return {
      name: "read_note",
      description: "Read the full content of a note by its vault-relative path.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path to the note (e.g. 'folder/note.md')"),
      }),
      handler: async (params) => {
        const { path } = params as { path: string };
        const content = await this.vault.readFile(path);
        return textResult(content);
      },
    };
  }

  private createNote(): ToolDefinition {
    return {
      name: "create_note",
      description: "Create a new markdown note. Fails if the file already exists.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path for the new note"),
        content: z.string().describe("Markdown content for the note"),
        overwrite: z.boolean().optional().describe("Allow overwriting an existing file (default: false)"),
      }),
      handler: async (params) => {
        const { path, content, overwrite } = params as { path: string; content: string; overwrite?: boolean };
        if (!overwrite && (await this.vault.exists(path))) {
          return textResult(`Error: File already exists at '${path}'. Use overwrite: true to replace.`);
        }
        await this.vault.writeFile(path, content);
        return textResult(`Created note at '${path}'.`);
      },
    };
  }

  private appendToNote(): ToolDefinition {
    return {
      name: "append_to_note",
      description: "Append content to the end of an existing note.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path to the note"),
        content: z.string().describe("Content to append"),
        heading: z.string().optional().describe("Append under this heading (if found)"),
      }),
      handler: async (params) => {
        const { path, content, heading } = params as { path: string; content: string; heading?: string };
        const existing = await this.vault.readFile(path);

        let updated: string;
        if (heading) {
          const headingRegex = new RegExp(`^(#{1,6})\\s+${escapeRegex(heading)}\\s*$`, "m");
          const match = headingRegex.exec(existing);
          if (match) {
            const level = match[1].length;
            const afterHeading = existing.slice(match.index + match[0].length);
            const nextHeadingRegex = new RegExp(`^#{1,${level}}\\s+`, "m");
            const nextMatch = nextHeadingRegex.exec(afterHeading);
            const insertPos = nextMatch
              ? match.index + match[0].length + nextMatch.index
              : existing.length;
            updated = `${existing.slice(0, insertPos)}\n${content}\n${existing.slice(insertPos)}`;
          } else {
            updated = `${existing}\n\n## ${heading}\n\n${content}`;
          }
        } else {
          updated = `${existing}\n\n${content}`;
        }

        await this.vault.writeFile(path, updated);
        return textResult(`Appended to '${path}'.`);
      },
    };
  }

  private deleteNote(): ToolDefinition {
    return {
      name: "delete",
      description: "Delete a file from the vault. This is permanent.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path to delete"),
      }),
      handler: async (params) => {
        const { path } = params as { path: string };
        await this.vault.deleteFile(path);
        return textResult(`Deleted '${path}'.`);
      },
    };
  }

  private searchContent(): ToolDefinition {
    return {
      name: "search_content",
      description: "Search for text or regex pattern across all markdown files in the vault.",
      inputSchema: z.object({
        query: z.string().describe("Search query (text or regex pattern)"),
        regex: z.boolean().optional().describe("Treat query as regex (default: false)"),
        caseSensitive: z.boolean().optional().describe("Case-sensitive search (default: false)"),
        maxResults: z.number().optional().describe("Maximum results to return (default: 100)"),
      }),
      handler: async (params) => {
        const { query, regex, caseSensitive, maxResults } = params as {
          query: string;
          regex?: boolean;
          caseSensitive?: boolean;
          maxResults?: number;
        };
        const results = await this.vault.searchContent(query, { regex, caseSensitive, maxResults });
        return jsonResult({ count: results.length, results });
      },
    };
  }

  private vaultStructure(): ToolDefinition {
    return {
      name: "vault_structure",
      description: "Get the vault's directory tree structure.",
      inputSchema: z.object({
        path: z.string().optional().describe("Subdirectory to list (default: vault root)"),
      }),
      handler: async (params) => {
        const { path } = params as { path?: string };
        const structure = await this.vault.getStructure(path);
        return jsonResult(structure);
      },
    };
  }

  private fileMetadata(): ToolDefinition {
    return {
      name: "file_metadata",
      description: "Get metadata for a note: frontmatter properties, tags, headings, and wikilinks.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path to the note"),
      }),
      handler: async (params) => {
        const { path } = params as { path: string };
        const metadata = await this.vault.getMetadata(path);
        return jsonResult(metadata);
      },
    };
  }

  private vaultTags(): ToolDefinition {
    return {
      name: "vault_tags",
      description: "Get all tags used across the vault with their usage counts.",
      inputSchema: z.object({}),
      handler: async () => {
        const tags = await this.vault.getAllTags();
        const sorted = Object.entries(tags).sort((a, b) => b[1] - a[1]);
        return jsonResult({ count: sorted.length, tags: Object.fromEntries(sorted) });
      },
    };
  }

  private searchByTag(): ToolDefinition {
    return {
      name: "search_by_tag",
      description: "Find all notes that have a specific tag (in frontmatter or inline).",
      inputSchema: z.object({
        tag: z.string().describe("Tag to search for (with or without #)"),
      }),
      handler: async (params) => {
        const { tag } = params as { tag: string };
        const files = await this.vault.findByTag(tag);
        return jsonResult({ count: files.length, files });
      },
    };
  }

  private searchByProperty(): ToolDefinition {
    return {
      name: "search_by_property",
      description: "Find notes by frontmatter property name and optional value.",
      inputSchema: z.object({
        property: z.string().describe("Frontmatter property name"),
        value: z.string().optional().describe("Property value to match (omit to find all with this property)"),
      }),
      handler: async (params) => {
        const { property, value } = params as { property: string; value?: string };
        const results = await this.vault.findByProperty(property, value);
        return jsonResult({ count: results.length, results });
      },
    };
  }

  private recentFiles(): ToolDefinition {
    return {
      name: "recent_files",
      description: "Get recently modified files in the vault, sorted newest first.",
      inputSchema: z.object({
        count: z.number().optional().describe("Number of files to return (default: 20)"),
      }),
      handler: async (params) => {
        const { count } = params as { count?: number };
        const files = await this.vault.getRecentFiles(count);
        return jsonResult(
          files.map((f) => ({
            path: f.path,
            modified: new Date(f.mtimeMs).toISOString(),
            size: f.size,
          })),
        );
      },
    };
  }

  private setFrontmatter(): ToolDefinition {
    return {
      name: "set_frontmatter",
      description: "Set or update frontmatter properties on a note. Existing properties are preserved.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path to the note"),
        properties: z.record(z.unknown()).describe("Key-value pairs to set in frontmatter"),
      }),
      handler: async (params) => {
        const { path, properties } = params as { path: string; properties: Record<string, unknown> };
        const raw = await this.vault.readFile(path);
        const updated = updateFrontmatter(raw, properties);
        await this.vault.writeFile(path, updated);
        return textResult(`Updated frontmatter on '${path}'.`);
      },
    };
  }

  private renameFile(): ToolDefinition {
    return {
      name: "rename",
      description: "Rename or move a file. Optionally updates wikilinks across the vault.",
      inputSchema: z.object({
        oldPath: z.string().describe("Current vault-relative path"),
        newPath: z.string().describe("New vault-relative path"),
        updateLinks: z.boolean().optional().describe("Update wikilinks in other notes (default: true)"),
      }),
      handler: async (params) => {
        const { oldPath, newPath, updateLinks = true } = params as {
          oldPath: string;
          newPath: string;
          updateLinks?: boolean;
        };

        if (updateLinks) {
          const count = await this.vault.renameWithLinks(oldPath, newPath);
          return textResult(`Renamed '${oldPath}' to '${newPath}'. Updated ${count} file(s) with wikilink references.`);
        }

        await this.vault.renameFile(oldPath, newPath);
        return textResult(`Renamed '${oldPath}' to '${newPath}'.`);
      },
    };
  }

  private dailyNote(): ToolDefinition {
    return {
      name: "daily_note",
      description: "Get or create today's daily note.",
      inputSchema: z.object({
        date: z.string().optional().describe("Date in YYYY-MM-DD format (default: today)"),
      }),
      handler: async (params) => {
        const { date } = params as { date?: string };
        const targetDate = date ?? new Date().toISOString().slice(0, 10);
        const folder = this.config.dailyNoteFolder ?? "Daily Notes";
        const path = `${folder}/${targetDate}.md`;

        if (await this.vault.exists(path)) {
          const content = await this.vault.readFile(path);
          return textResult(content);
        }

        let content: string;
        if (this.config.dailyNoteTemplate && (await this.vault.exists(this.config.dailyNoteTemplate))) {
          content = await this.vault.readFile(this.config.dailyNoteTemplate);
          content = content.replace(/\{\{date\}\}/g, targetDate);
          content = content.replace(/\{\{title\}\}/g, targetDate);
        } else {
          content = `---\ndate: ${targetDate}\n---\n\n# ${targetDate}\n\n`;
        }

        await this.vault.writeFile(path, content);
        return textResult(`Created daily note at '${path}'.\n\n${content}`);
      },
    };
  }

  private getInstructions(): ToolDefinition {
    return {
      name: "get_instructions",
      description: "Read vault-specific instructions from CLAUDE.md and AGENTS.md at the vault root.",
      inputSchema: z.object({}),
      handler: async () => {
        const parts: string[] = [];

        for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
          if (await this.vault.exists(filename)) {
            const content = await this.vault.readFile(filename);
            parts.push(`# ${filename}\n\n${content}`);
          }
        }

        if (parts.length === 0) {
          return textResult("No instruction files (CLAUDE.md, AGENTS.md) found in the vault root.");
        }

        return textResult(parts.join("\n\n---\n\n"));
      },
    };
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

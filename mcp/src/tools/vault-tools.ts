import { extname } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { escapeRegex } from "../util.js";
import { updateFrontmatter } from "../vault/frontmatter.js";
import {
	AccessRefusal,
	type DirectoryEntry,
	FileExistsError,
	type VaultService,
} from "../vault/vault-service.js";
import type { Access } from "./tiers.js";
import type { ToolDefinition, ToolProvider } from "./types.js";

function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

function jsonResult(
	data: Record<string, unknown>,
	textData: unknown = data,
): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(textData, null, 2) }],
		structuredContent: data,
	};
}

/** A daily-note date. Anything else could steer the path outside the daily folder. */
const DAILY_NOTE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Offset where a note's body starts: just past a leading `---` frontmatter block. */
export function bodyStart(note: string): number {
	const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(note);
	return match ? match[0].length : 0;
}

/**
 * Insert `content` at the end of the section under `heading`, or add a new
 * `## heading` section at the end when the note has no such heading. Headings
 * inside the frontmatter block are not candidates: a YAML comment such as
 * `# status` would otherwise route the content into the properties.
 */
export function insertUnderHeading(
	note: string,
	heading: string,
	content: string,
): string {
	// Trimmed, and matched with [ \t] rather than \s: a whitespace-only heading
	// next to `\s+`/`\s*` backtracks quadratically on a long line of spaces.
	const title = heading.trim();
	if (title === "") throw new Error("heading must contain non-whitespace text");
	const offset = bodyStart(note);
	const body = note.slice(offset);
	const headingRegex = new RegExp(
		`^(#{1,6})[ \\t]+${escapeRegex(title)}[ \\t]*$`,
		"m",
	);
	const match = headingRegex.exec(body);
	if (!match) return `${note}\n\n## ${title}\n\n${content}`;
	const level = match[1].length;
	const sectionStart = offset + match.index + match[0].length;
	const nextHeading = new RegExp(`^#{1,${level}}[ \\t]`, "m").exec(
		note.slice(sectionStart),
	);
	const insertPos = nextHeading
		? sectionStart + nextHeading.index
		: note.length;
	return `${note.slice(0, insertPos)}\n${content}\n${note.slice(insertPos)}`;
}

const directoryEntrySchema: z.ZodType<DirectoryEntry> = z.lazy(() =>
	z.object({
		name: z.string(),
		type: z.enum(["file", "directory"]),
		children: z.array(directoryEntrySchema).optional(),
	}),
);

export class VaultToolProvider implements ToolProvider {
	id = "vault";
	name = "Vault Tools";

	/** The policy-bound view every non-`full` access uses. */
	private readonly restrictedVault: VaultService;

	constructor(
		private vault: VaultService,
		private config: Config,
	) {
		// Obsidian stores the template path without `.md`; protect both spellings.
		const template = config.dailyNoteTemplate;
		this.restrictedVault = vault.withPolicy({
			protectedPaths: template
				? [template, extname(template) ? template : `${template}.md`]
				: [],
			writeDirs: config.limitedWriteDirs,
		});
	}

	/** Fails closed: anything other than `full` gets the restricted view. */
	private vaultFor(access: Access): VaultService {
		return access === "full" ? this.vault : this.restrictedVault;
	}

	getTools(): ToolDefinition[] {
		return [
			this.readNote(),
			this.createNote(),
			this.appendToNote(),
			this.deleteNote(),
			this.deleteNoteDeprecatedAlias(),
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
			readOnly: true,
			description:
				"Read the full content of a note by its vault-relative path.",
			inputSchema: z.object({
				path: z
					.string()
					.describe("Vault-relative path to the note (e.g. 'folder/note.md')"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { path } = params as { path: string };
				const content = await vault.readFile(path);
				return textResult(content);
			},
		};
	}

	private createNote(): ToolDefinition {
		return {
			name: "create_note",
			description:
				"Create a new markdown note. Fails if the file already exists.",
			inputSchema: z.object({
				path: z.string().describe("Vault-relative path for the new note"),
				content: z.string().describe("Markdown content for the note"),
				overwrite: z
					.boolean()
					.optional()
					.describe("Allow overwriting an existing file (default: false)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { path, content, overwrite } = params as {
					path: string;
					content: string;
					overwrite?: boolean;
				};
				const exists = () =>
					textResult(
						`Error: File already exists at '${path}'. Use overwrite: true to replace.`,
					);
				if (overwrite) {
					if (ctx.access !== "full") {
						throw new AccessRefusal(
							"overwrite is not permitted for this access tier; the note was not changed.",
							"overwrite",
						);
					}
					await vault.writeFile(path, content);
					return textResult(`Created note at '${path}'.`);
				}
				try {
					// Exclusive create: the path policy runs first, then O_EXCL refuses
					// an existing file (or one that appears at the last moment).
					await vault.createFile(path, content);
				} catch (err) {
					if (err instanceof FileExistsError) return exists();
					throw err;
				}
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
				heading: z
					.string()
					.optional()
					.describe("Append under this heading (if found)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { path, content, heading } = params as {
					path: string;
					content: string;
					heading?: string;
				};
				if (heading) {
					await vault.updateIfUnchanged(path, (existing) =>
						insertUnderHeading(existing, heading, content),
					);
				} else {
					// O_APPEND: no read-modify-write, so a concurrent edit is kept.
					await vault.appendFile(path, `\n\n${content}`);
				}
				return textResult(`Appended to '${path}'.`);
			},
		};
	}

	private deleteNoteHandler = async (
		params: Record<string, unknown>,
		ctx: { access: Access },
	): Promise<CallToolResult> => {
		const { path } = params as { path: string };
		await this.vaultFor(ctx.access).deleteFile(path);
		return textResult(`Deleted '${path}'.`);
	};

	private deleteNote(): ToolDefinition {
		return {
			name: "delete_note",
			description: "Delete a file from the vault. This is permanent.",
			inputSchema: z.object({
				path: z.string().describe("Vault-relative path to delete"),
			}),
			handler: this.deleteNoteHandler,
		};
	}

	/**
	 * Deprecated alias for `delete_note`, kept for one release for backward
	 * compatibility. Tracked for removal next minor.
	 */
	private deleteNoteDeprecatedAlias(): ToolDefinition {
		return {
			name: "delete",
			description:
				"[DEPRECATED — use delete_note] Delete a file from the vault. This is permanent.",
			inputSchema: z.object({
				path: z.string().describe("Vault-relative path to delete"),
			}),
			handler: this.deleteNoteHandler,
		};
	}

	private searchContent(): ToolDefinition {
		return {
			name: "search_content",
			readOnly: true,
			outputSchema: z.object({
				count: z.number().int().nonnegative(),
				results: z.array(
					z.object({
						path: z.string(),
						line: z.number().int().positive(),
						text: z.string(),
					}),
				),
			}),
			description:
				"Search for text or a regex pattern across all markdown files in the vault. " +
				"Example: {query: 'TODO'} for literal text, or {query: '#[a-z]+', regex: true}. " +
				"Returns up to maxResults matches (default 100, max 1000), each with path and line number.",
			inputSchema: z.object({
				query: z.string().describe("Search query (text or regex pattern)"),
				regex: z
					.boolean()
					.optional()
					.describe("Treat query as regex (default: false)"),
				caseSensitive: z
					.boolean()
					.optional()
					.describe("Case-sensitive search (default: false)"),
				maxResults: z
					.number()
					.int()
					.positive()
					.max(1000)
					.optional()
					.describe("Maximum results to return (default: 100, max: 1000)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { query, regex, caseSensitive, maxResults } = params as {
					query: string;
					regex?: boolean;
					caseSensitive?: boolean;
					maxResults?: number;
				};
				if (regex && ctx.access !== "full") {
					// A caller-supplied regex can stall the event loop for every tier (ReDoS).
					throw new AccessRefusal(
						"regex search is not permitted for this access tier; search for literal text instead.",
						"regex",
					);
				}
				const results = await vault.searchContent(query, {
					regex,
					caseSensitive,
					maxResults,
				});
				return jsonResult({ count: results.length, results });
			},
		};
	}

	private vaultStructure(): ToolDefinition {
		return {
			name: "vault_structure",
			readOnly: true,
			outputSchema: z.object({ entries: z.array(directoryEntrySchema) }),
			description: "Get the vault's directory tree structure.",
			inputSchema: z.object({
				path: z
					.string()
					.optional()
					.describe("Subdirectory to list (default: vault root)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { path } = params as { path?: string };
				const structure = await vault.getStructure(path);
				return jsonResult({ entries: structure }, structure);
			},
		};
	}

	private fileMetadata(): ToolDefinition {
		return {
			name: "file_metadata",
			readOnly: true,
			outputSchema: z.object({
				path: z.string(),
				// The parser preserves any valid YAML root, including scalars/sequences.
				frontmatter: z.unknown(),
				tags: z.array(z.string()),
				headings: z.array(
					z.object({ level: z.number().int(), text: z.string() }),
				),
				wikilinks: z.array(
					z.object({
						path: z.string(),
						alias: z.string().optional(),
						heading: z.string().optional(),
					}),
				),
			}),
			description:
				"Get metadata for a note: frontmatter properties, tags, headings, and wikilinks.",
			inputSchema: z.object({
				path: z.string().describe("Vault-relative path to the note"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { path } = params as { path: string };
				const metadata = await vault.getMetadata(path);
				return jsonResult({ ...metadata });
			},
		};
	}

	private vaultTags(): ToolDefinition {
		return {
			name: "vault_tags",
			readOnly: true,
			outputSchema: z.object({
				count: z.number().int().nonnegative(),
				tags: z.record(z.string(), z.number().int().nonnegative()),
			}),
			description:
				"Get all tags used across the vault with their usage counts. Takes no arguments. " +
				"To find the notes carrying a given tag, use search_by_tag.",
			inputSchema: z.object({}),
			handler: async (_params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const tags = await vault.getAllTags();
				const sorted = Object.entries(tags).sort((a, b) => b[1] - a[1]);
				return jsonResult({
					count: sorted.length,
					tags: Object.fromEntries(sorted),
				});
			},
		};
	}

	private searchByTag(): ToolDefinition {
		return {
			name: "search_by_tag",
			readOnly: true,
			outputSchema: z.object({
				count: z.number().int().nonnegative(),
				files: z.array(z.string()),
			}),
			description:
				"Find all notes that have a specific tag (in frontmatter or inline).",
			inputSchema: z.object({
				tag: z.string().describe("Tag to search for (with or without #)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { tag } = params as { tag: string };
				const files = await vault.findByTag(tag);
				return jsonResult({ count: files.length, files });
			},
		};
	}

	private searchByProperty(): ToolDefinition {
		return {
			name: "search_by_property",
			readOnly: true,
			outputSchema: z.object({
				count: z.number().int().nonnegative(),
				results: z.array(z.object({ path: z.string(), value: z.unknown() })),
			}),
			description:
				"Find notes by frontmatter property name and optional value.",
			inputSchema: z.object({
				property: z.string().describe("Frontmatter property name"),
				value: z
					.string()
					.optional()
					.describe(
						"Property value to match (omit to find all with this property)",
					),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { property, value } = params as {
					property: string;
					value?: string;
				};
				const results = await vault.findByProperty(property, value);
				return jsonResult({ count: results.length, results });
			},
		};
	}

	private recentFiles(): ToolDefinition {
		return {
			name: "recent_files",
			readOnly: true,
			outputSchema: z.object({
				files: z.array(
					z.object({
						path: z.string(),
						modified: z.string(),
						size: z.number().nonnegative(),
					}),
				),
			}),
			description:
				"Get recently modified files in the vault, sorted newest first.",
			inputSchema: z.object({
				count: z
					.number()
					.int()
					.positive()
					.max(500)
					.optional()
					.describe("Number of files to return (default: 20, max: 500)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { count } = params as { count?: number };
				const files = await vault.getRecentFiles(count);
				const recent = files.map((f) => ({
					path: f.path,
					modified: new Date(f.mtimeMs).toISOString(),
					size: f.size,
				}));
				return jsonResult({ files: recent }, recent);
			},
		};
	}

	private setFrontmatter(): ToolDefinition {
		return {
			name: "set_frontmatter",
			description:
				"Set or update frontmatter properties on a note. Existing properties are preserved.",
			inputSchema: z.object({
				path: z.string().describe("Vault-relative path to the note"),
				properties: z
					.record(z.string(), z.unknown())
					.describe("Key-value pairs to set in frontmatter"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { path, properties } = params as {
					path: string;
					properties: Record<string, unknown>;
				};
				const raw = await vault.readFile(path);
				const updated = updateFrontmatter(raw, properties);
				await vault.writeFile(path, updated);
				return textResult(`Updated frontmatter on '${path}'.`);
			},
		};
	}

	private renameFile(): ToolDefinition {
		return {
			name: "rename",
			description:
				"Rename or move a file. By default (updateLinks: true) it rewrites every " +
				"[[wikilink]] referencing this note across the entire vault; set updateLinks: false to skip that.",
			inputSchema: z.object({
				oldPath: z.string().describe("Current vault-relative path"),
				newPath: z.string().describe("New vault-relative path"),
				updateLinks: z
					.boolean()
					.optional()
					.describe("Update wikilinks in other notes (default: true)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const {
					oldPath,
					newPath,
					updateLinks = true,
				} = params as {
					oldPath: string;
					newPath: string;
					updateLinks?: boolean;
				};

				if (updateLinks) {
					const count = await vault.renameWithLinks(oldPath, newPath);
					return textResult(
						`Renamed '${oldPath}' to '${newPath}'. Updated ${count} file(s) with wikilink references.`,
					);
				}

				await vault.renameFile(oldPath, newPath);
				return textResult(`Renamed '${oldPath}' to '${newPath}'.`);
			},
		};
	}

	private dailyNote(): ToolDefinition {
		return {
			name: "daily_note",
			description: "Get or create today's daily note.",
			inputSchema: z.object({
				date: z
					.string()
					.regex(DAILY_NOTE_DATE, "date must be YYYY-MM-DD")
					.optional()
					.describe("Date in YYYY-MM-DD format (default: today)"),
			}),
			handler: async (params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const { date } = params as { date?: string };
				const targetDate = date ?? new Date().toISOString().slice(0, 10);
				if (!DAILY_NOTE_DATE.test(targetDate)) {
					throw new Error(
						`date must be YYYY-MM-DD, got ${targetDate.length} characters`,
					);
				}
				const folder = this.config.dailyNoteFolder ?? "Daily Notes";
				const path = `${folder}/${targetDate}.md`;

				if (await vault.exists(path)) {
					const content = await vault.readFile(path);
					return textResult(content);
				}

				let content: string;
				if (
					this.config.dailyNoteTemplate &&
					(await this.vault.exists(this.config.dailyNoteTemplate))
				) {
					content = await this.vault.readFile(this.config.dailyNoteTemplate);
					content = content.replace(/\{\{date\}\}/g, targetDate);
					content = content.replace(/\{\{title\}\}/g, targetDate);
				} else {
					content = `---\ndate: ${targetDate}\n---\n\n# ${targetDate}\n\n`;
				}

				try {
					await vault.createFile(path, content);
				} catch (err) {
					// Another client created it since the check: return theirs, never replace.
					if (err instanceof FileExistsError) {
						return textResult(await vault.readFile(path));
					}
					throw err;
				}
				return textResult(`Created daily note at '${path}'.\n\n${content}`);
			},
		};
	}

	private getInstructions(): ToolDefinition {
		return {
			name: "get_instructions",
			readOnly: true,
			description:
				"Read vault-specific instructions from CLAUDE.md and AGENTS.md at the vault root. Takes no arguments.",
			inputSchema: z.object({}),
			handler: async (_params, ctx) => {
				const vault = this.vaultFor(ctx.access);
				const parts: string[] = [];

				for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
					if (await vault.exists(filename)) {
						const content = await vault.readFile(filename);
						parts.push(`# ${filename}\n\n${content}`);
					}
				}

				if (parts.length === 0) {
					return textResult(
						"No instruction files (CLAUDE.md, AGENTS.md) found in the vault root.",
					);
				}

				return textResult(parts.join("\n\n---\n\n"));
			},
		};
	}
}

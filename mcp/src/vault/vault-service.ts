import {
	rename as fsRename,
	mkdir,
	readFile,
	readdir,
	realpath,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	sep,
} from "node:path";
import { escapeRegex } from "../util.js";
import { extractHeadings, extractTags, parseNote } from "./frontmatter.js";
import { extractWikilinks, rewriteWikilinks } from "./wikilink.js";

/** Directories to skip when walking the vault. */
const IGNORED_DIRS = new Set([
	".obsidian",
	".git",
	".trash",
	".claude",
	"node_modules",
]);

/** Upper bounds so a hostile/buggy caller cannot request unbounded work. */
const MAX_SEARCH_RESULTS = 1000;
const MAX_RECENT_FILES = 500;

/**
 * Resolve the real (symlink-followed) path of the nearest existing ancestor of `p`.
 * Targets of a write may not exist yet, so we climb until something resolves; a
 * non-existent tail cannot itself be a symlink, so the nearest existing ancestor is
 * the meaningful boundary to check.
 */
async function realpathNearestExisting(p: string): Promise<string> {
	let cur = p;
	for (;;) {
		try {
			return await realpath(cur);
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return cur;
			cur = parent;
		}
	}
}

export interface VaultFile {
	path: string;
	name: string;
	extension: string;
	mtimeMs: number;
	size: number;
}

export interface FileMetadata {
	path: string;
	frontmatter: Record<string, unknown> | null;
	tags: string[];
	headings: Array<{ level: number; text: string }>;
	wikilinks: Array<{ path: string; alias?: string; heading?: string }>;
}

export interface DirectoryEntry {
	name: string;
	type: "file" | "directory";
	children?: DirectoryEntry[];
}

export class VaultService {
	private realVaultPath: string | undefined;

	constructor(private readonly vaultPath: string) {}

	/**
	 * Sync structural guard (fast prefilter): reject absolute inputs and `..` traversal.
	 * NOTE: `path.join(base, "/x")` does NOT escape — it yields `base/x` — so absolute
	 * inputs must be rejected explicitly rather than relied upon to be neutralized.
	 */
	private resolve(vaultRelPath: string): string {
		if (isAbsolute(vaultRelPath)) {
			throw new Error(
				`Path traversal rejected (absolute path): ${vaultRelPath}`,
			);
		}
		const resolved = join(this.vaultPath, vaultRelPath);
		const rel = relative(this.vaultPath, resolved);
		if (rel === ".." || rel.startsWith(`..${sep}`)) {
			throw new Error(`Path traversal rejected: ${vaultRelPath}`);
		}
		return resolved;
	}

	/** Cache and return the real (symlink-resolved) absolute path of the vault root. */
	private async getRealVaultPath(): Promise<string> {
		if (this.realVaultPath === undefined) {
			this.realVaultPath = await realpath(this.vaultPath);
		}
		return this.realVaultPath;
	}

	/**
	 * Async guard: the sync prefilter PLUS a realpath boundary check that defeats
	 * symlinks inside the vault pointing outside it. Compares against a `path.sep`
	 * boundary so a sibling like `/vault-2` is not treated as inside `/vault`.
	 */
	private async resolveSafe(vaultRelPath: string): Promise<string> {
		const resolved = this.resolve(vaultRelPath);
		const realRoot = await this.getRealVaultPath();
		const realProbe = await realpathNearestExisting(resolved);
		if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
			throw new Error(
				`Path traversal rejected (symlink escape): ${vaultRelPath}`,
			);
		}
		return resolved;
	}

	/** Read a file's content. */
	async readFile(path: string): Promise<string> {
		return readFile(await this.resolveSafe(path), "utf-8");
	}

	/** Write content to a file, creating parent directories as needed. */
	async writeFile(path: string, content: string): Promise<void> {
		const absPath = await this.resolveSafe(path);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, content, "utf-8");
	}

	/** Delete a file. */
	async deleteFile(path: string): Promise<void> {
		await unlink(await this.resolveSafe(path));
	}

	/** Rename/move a file. */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const absOld = await this.resolveSafe(oldPath);
		const absNew = await this.resolveSafe(newPath);
		await mkdir(dirname(absNew), { recursive: true });
		await fsRename(absOld, absNew);
	}

	/** Check if a file exists. */
	async exists(path: string): Promise<boolean> {
		try {
			await stat(await this.resolveSafe(path));
			return true;
		} catch {
			return false;
		}
	}

	/** Get file stats. */
	async stat(path: string): Promise<VaultFile> {
		const absPath = await this.resolveSafe(path);
		const s = await stat(absPath);
		return {
			path,
			name: basename(path),
			extension: extname(path),
			mtimeMs: s.mtimeMs,
			size: s.size,
		};
	}

	/** List all markdown files in the vault. */
	async listMarkdownFiles(): Promise<VaultFile[]> {
		const files: VaultFile[] = [];
		await this.walkDir(this.vaultPath, files);
		return files;
	}

	private async walkDir(dir: string, files: VaultFile[]): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				await this.walkDir(join(dir, entry.name), files);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const absPath = join(dir, entry.name);
				const relPath = relative(this.vaultPath, absPath);
				const s = await stat(absPath);
				files.push({
					path: relPath,
					name: entry.name,
					extension: ".md",
					mtimeMs: s.mtimeMs,
					size: s.size,
				});
			}
		}
	}

	/** Get the vault directory tree. */
	async getStructure(rootPath = ""): Promise<DirectoryEntry[]> {
		const absRoot = rootPath
			? await this.resolveSafe(rootPath)
			: this.vaultPath;
		return this.buildTree(absRoot);
	}

	private async buildTree(dir: string): Promise<DirectoryEntry[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const result: DirectoryEntry[] = [];

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				const children = await this.buildTree(join(dir, entry.name));
				result.push({ name: entry.name, type: "directory", children });
			} else if (entry.isFile()) {
				result.push({ name: entry.name, type: "file" });
			}
		}

		return result.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	/** Get metadata for a single file. */
	async getMetadata(path: string): Promise<FileMetadata> {
		const content = await this.readFile(path);
		const { frontmatter } = parseNote(content);
		const tags = extractTags(content);
		const headings = extractHeadings(content);
		const wikilinks = extractWikilinks(content).map(
			({ path, alias, heading }) => ({
				path,
				alias,
				heading,
			}),
		);

		return { path, frontmatter, tags, headings, wikilinks };
	}

	/** Search for text/regex across all markdown files. */
	async searchContent(
		query: string,
		options: {
			regex?: boolean;
			caseSensitive?: boolean;
			maxResults?: number;
		} = {},
	): Promise<Array<{ path: string; line: number; text: string }>> {
		const { regex = false, caseSensitive = false, maxResults = 100 } = options;
		// Clamp defensively: the schema bounds this too, but VaultService must not trust callers.
		const limit = Math.min(
			Math.max(1, Math.floor(maxResults)),
			MAX_SEARCH_RESULTS,
		);
		const files = await this.listMarkdownFiles();
		const results: Array<{ path: string; line: number; text: string }> = [];

		const flags = caseSensitive ? "g" : "gi";
		const pattern = regex
			? new RegExp(query, flags)
			: new RegExp(escapeRegex(query), flags);

		for (const file of files) {
			if (results.length >= limit) break;
			const content = await this.readFile(file.path);
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				if (results.length >= limit) break;
				if (pattern.test(lines[i])) {
					results.push({ path: file.path, line: i + 1, text: lines[i] });
				}
				pattern.lastIndex = 0;
			}
		}

		return results;
	}

	/** Get all tags across the vault with usage counts. */
	async getAllTags(): Promise<Record<string, number>> {
		const files = await this.listMarkdownFiles();
		const tagCounts: Record<string, number> = {};

		for (const file of files) {
			const content = await this.readFile(file.path);
			const tags = extractTags(content);
			for (const tag of tags) {
				tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
			}
		}

		return tagCounts;
	}

	/** Find files matching a tag. */
	async findByTag(tag: string): Promise<string[]> {
		const files = await this.listMarkdownFiles();
		const matches: string[] = [];

		for (const file of files) {
			const content = await this.readFile(file.path);
			const tags = extractTags(content);
			if (tags.includes(tag.replace(/^#/, ""))) {
				matches.push(file.path);
			}
		}

		return matches;
	}

	/** Find files matching a frontmatter property value. */
	async findByProperty(
		property: string,
		value?: string,
	): Promise<Array<{ path: string; value: unknown }>> {
		const files = await this.listMarkdownFiles();
		const matches: Array<{ path: string; value: unknown }> = [];

		for (const file of files) {
			const content = await this.readFile(file.path);
			const { frontmatter } = parseNote(content);
			if (!frontmatter || !(property in frontmatter)) continue;

			const propValue = frontmatter[property];
			if (value === undefined || String(propValue) === value) {
				matches.push({ path: file.path, value: propValue });
			}
		}

		return matches;
	}

	/** Get recently modified files, sorted newest first. */
	async getRecentFiles(count = 20): Promise<VaultFile[]> {
		const limit = Math.min(Math.max(1, Math.floor(count)), MAX_RECENT_FILES);
		const files = await this.listMarkdownFiles();
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return files.slice(0, limit);
	}

	/** Rename a file and update wikilinks across the vault. */
	async renameWithLinks(oldPath: string, newPath: string): Promise<number> {
		await this.renameFile(oldPath, newPath);

		// Update wikilinks in all markdown files
		const files = await this.listMarkdownFiles();
		let updatedCount = 0;

		for (const file of files) {
			const content = await this.readFile(file.path);
			const updated = rewriteWikilinks(content, oldPath, newPath);
			if (updated !== content) {
				await this.writeFile(file.path, updated);
				updatedCount++;
			}
		}

		return updatedCount;
	}
}

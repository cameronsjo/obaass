import { constants as fsConstants } from "node:fs";
import {
	rename as fsRename,
	lstat,
	mkdir,
	open,
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
	normalize,
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

/** True when `p` is `root` or lies below it, compared on a `path.sep` boundary. */
function isWithin(p: string, root: string): boolean {
	return p === root || p.startsWith(root + sep);
}

/** Thrown when an exclusive create finds the path already taken. */
export class FileExistsError extends Error {
	readonly code = "EEXIST";
}

/** Thrown when a read-modify-write finds the file changed since it was read. */
export class ConcurrentModificationError extends Error {}

/** Why a path was refused; carried for the refusal audit log, never the path. */
export type AccessRefusalKind =
	| "outside_root"
	| "symlink"
	| "dot_segment"
	| "non_md"
	| "instruction_file"
	| "protected_path"
	| "write_operation"
	| "overwrite"
	| "regex";

/** A containment, path-policy, or tier-capability refusal; `kind` feeds the audit log. */
export class AccessRefusal extends Error {
	constructor(
		message: string,
		readonly kind: AccessRefusalKind,
	) {
		super(message);
	}
}

/**
 * Restrictions for a non-`full` tier. Paths are vault-relative and compared
 * case-insensitively.
 */
export interface PathPolicy {
	/** Files the tier may never write, such as the configured daily-note template. */
	protectedPaths: readonly string[];
}

/** Files agents load as instructions; a restricted tier may not write them anywhere. */
const INSTRUCTION_FILES = new Set(["claude.md", "agents.md", "gemini.md"]);

type Intent = "read" | "write";

function policyRefusal(kind: AccessRefusalKind): AccessRefusal {
	return new AccessRefusal(
		`Path policy refused (${kind}): not permitted for this access tier.`,
		kind,
	);
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

	constructor(
		private readonly vaultPath: string,
		private readonly policy?: PathPolicy,
	) {}

	/** A view of the same vault that enforces `policy` on every path and walk. */
	withPolicy(policy: PathPolicy): VaultService {
		return new VaultService(this.vaultPath, policy);
	}

	/**
	 * Path-policy check for a vault-relative path. Applied to the requested path
	 * and again to the resolved real path, so an in-vault link cannot reach a
	 * dot folder or an instruction file under an innocent name.
	 */
	private checkPolicy(rel: string, intent: Intent): void {
		if (!this.policy) return;
		const segments = rel === "" ? [] : rel.split(sep);
		if (segments.some((segment) => segment.startsWith("."))) {
			throw policyRefusal("dot_segment");
		}
		if (intent === "read") return;
		if (extname(rel).toLowerCase() !== ".md") throw policyRefusal("non_md");
		if (INSTRUCTION_FILES.has(basename(rel).toLowerCase())) {
			throw policyRefusal("instruction_file");
		}
		const lowered = rel.toLowerCase();
		if (
			this.policy.protectedPaths.some(
				(p) => normalize(p).toLowerCase() === lowered,
			)
		) {
			throw policyRefusal("protected_path");
		}
	}

	private refuseWriteOperation(): void {
		if (this.policy) throw policyRefusal("write_operation");
	}

	/**
	 * Sync structural guard (fast prefilter): reject absolute inputs and `..` traversal.
	 * NOTE: `path.join(base, "/x")` does NOT escape — it yields `base/x` — so absolute
	 * inputs must be rejected explicitly rather than relied upon to be neutralized.
	 */
	private resolve(vaultRelPath: string): string {
		if (isAbsolute(vaultRelPath)) {
			throw new AccessRefusal(
				`Path traversal rejected (absolute path): ${vaultRelPath}`,
				"outside_root",
			);
		}
		const resolved = join(this.vaultPath, vaultRelPath);
		const rel = relative(this.vaultPath, resolved);
		if (rel === ".." || rel.startsWith(`..${sep}`)) {
			throw new AccessRefusal(
				`Path traversal rejected: ${vaultRelPath}`,
				"outside_root",
			);
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
	 * Async guard: the sync prefilter, then a walk over every existing path
	 * component below the real vault root. Each symlink on the way must resolve
	 * inside the root; a dangling symlink is refused, because a later write would
	 * follow it to wherever it points. Only ENOENT ends the walk as "the rest does
	 * not exist yet"; any other lstat error refuses. Returns the lexical path so
	 * that delete and rename act on a link itself, not on its target.
	 */
	private async resolveSafe(
		vaultRelPath: string,
		intent: Intent = "read",
	): Promise<string> {
		const resolved = this.resolve(vaultRelPath);
		const realRoot = await this.getRealVaultPath();
		const rel = relative(this.vaultPath, resolved);
		this.checkPolicy(rel, intent);
		const parts = rel === "" ? [] : rel.split(sep);
		let current = realRoot;
		let walked = 0;
		for (const part of parts) {
			const next = join(current, part);
			let isLink: boolean;
			try {
				isLink = (await lstat(next)).isSymbolicLink();
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
				throw new AccessRefusal(
					`Path traversal rejected (unresolvable component): ${vaultRelPath}`,
					"outside_root",
				);
			}
			walked++;
			if (!isLink) {
				current = next;
				continue;
			}
			let target: string;
			try {
				target = await realpath(next);
			} catch {
				throw new AccessRefusal(
					`Path traversal rejected (dangling symlink escape): ${vaultRelPath}`,
					"symlink",
				);
			}
			if (!isWithin(target, realRoot)) {
				throw new AccessRefusal(
					`Path traversal rejected (symlink escape): ${vaultRelPath}`,
					"symlink",
				);
			}
			current = target;
		}
		if (this.policy) {
			const realTarget = join(current, ...parts.slice(walked));
			this.checkPolicy(relative(realRoot, realTarget), intent);
		}
		return resolved;
	}

	/** Read a file's content. */
	async readFile(path: string): Promise<string> {
		return readFile(await this.resolveSafe(path), "utf-8");
	}

	/** Write content to a file, creating parent directories as needed. */
	async writeFile(path: string, content: string): Promise<void> {
		this.refuseWriteOperation();
		const absPath = await this.resolveSafe(path, "write");
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, content, "utf-8");
	}

	/**
	 * Create a new file, creating parent directories as needed. Never replaces:
	 * the open is exclusive (O_CREAT|O_EXCL), which also refuses a symlink at the
	 * final component. Throws FileExistsError when the path is taken.
	 */
	async createFile(path: string, content: string): Promise<void> {
		const absPath = await this.resolveSafe(path, "write");
		await mkdir(dirname(absPath), { recursive: true });
		try {
			await writeFile(absPath, content, { encoding: "utf-8", flag: "wx" });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				throw new FileExistsError(`File already exists: ${path}`);
			}
			throw err;
		}
	}

	/**
	 * Append to the end of an existing file with O_APPEND, so a concurrent writer's
	 * bytes are kept rather than overwritten by a stale read. Never creates.
	 */
	async appendFile(path: string, content: string): Promise<void> {
		const absPath = await this.resolveSafe(path, "write");
		const handle = await open(
			absPath,
			fsConstants.O_WRONLY | fsConstants.O_APPEND,
		);
		try {
			await handle.writeFile(content, "utf-8");
		} finally {
			await handle.close();
		}
	}

	/**
	 * Read, transform, and write back a file, refusing when its size or mtime
	 * changed between the read and the write (a concurrent edit would be lost).
	 */
	async updateIfUnchanged(
		path: string,
		transform: (content: string) => string,
	): Promise<void> {
		const absPath = await this.resolveSafe(path, "write");
		const before = await stat(absPath);
		const updated = transform(await this.readFile(path));
		const after = await stat(absPath);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
			throw new ConcurrentModificationError(
				"The note changed while it was being updated; retry the call.",
			);
		}
		await writeFile(absPath, updated, "utf-8");
	}

	/** Delete a file. */
	async deleteFile(path: string): Promise<void> {
		this.refuseWriteOperation();
		await unlink(await this.resolveSafe(path, "write"));
	}

	/** Rename/move a file. */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		this.refuseWriteOperation();
		const absOld = await this.resolveSafe(oldPath, "write");
		const absNew = await this.resolveSafe(newPath, "write");
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

	/** Under a policy, dot entries are invisible to walks, trees, and searches. */
	private hidden(name: string): boolean {
		return !!this.policy && name.startsWith(".");
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
				if (IGNORED_DIRS.has(entry.name) || this.hidden(entry.name)) continue;
				await this.walkDir(join(dir, entry.name), files);
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".md") &&
				!this.hidden(entry.name)
			) {
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
				if (IGNORED_DIRS.has(entry.name) || this.hidden(entry.name)) continue;
				const children = await this.buildTree(join(dir, entry.name));
				result.push({ name: entry.name, type: "directory", children });
			} else if (entry.isFile() && !this.hidden(entry.name)) {
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

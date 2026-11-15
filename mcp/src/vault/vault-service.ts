import { constants as fsConstants } from "node:fs";
import {
	type FileHandle,
	rename as fsRename,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	readlink,
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
	resolve as resolvePath,
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

/**
 * Refuse a symlink at the final component when a write opens its checked real
 * target, so a link swapped in after the check is not followed. Undefined on
 * Windows, where `| undefined` leaves the flags unchanged.
 */
const NO_FOLLOW = fsConstants.O_NOFOLLOW;

/**
 * One queue per real target, shared by every VaultService view (the `full`
 * view and the restricted one), so a read-modify-write and an append to the
 * same note never interleave inside this process. Keys are lowercased, which
 * over-serializes two files differing only by case on a case-sensitive
 * filesystem and never under-serializes on a case-insensitive one.
 * debt: in-process only; writers outside this process (Sync, the backup
 * container) are still caught only by updateIfUnchanged's size/mtime check.
 */
const pathQueues = new Map<string, Promise<void>>();

async function withPathLock<T>(
	realPath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = realPath.toLowerCase();
	const prior = pathQueues.get(key) ?? Promise.resolve();
	const run = prior.then(fn);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	pathQueues.set(key, settled);
	try {
		return await run;
	} finally {
		if (pathQueues.get(key) === settled) pathQueues.delete(key);
	}
}

/** Open the checked real target without following a final symlink. */
async function openNoFollow(realPath: string, flags: number) {
	try {
		return await open(realPath, flags | NO_FOLLOW, 0o666);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ELOOP") {
			throw new AccessRefusal(
				"Path traversal rejected (the target became a symlink after it was checked).",
				"symlink",
			);
		}
		throw err;
	}
}

/**
 * Replace a file's content in place from offset 0, then cut it to the new
 * length. FileHandle.writeFile would start at the handle's current position,
 * which a prior read has moved to the end.
 */
async function overwrite(handle: FileHandle, text: string): Promise<void> {
	const buf = Buffer.from(text, "utf-8");
	let offset = 0;
	while (offset < buf.length) {
		const { bytesWritten } = await handle.write(
			buf,
			offset,
			buf.length - offset,
			offset,
		);
		offset += bytesWritten;
	}
	await handle.truncate(buf.length);
}

/** Symlink hops prospectiveRealPath follows before refusing, as the kernel does (ELOOP). */
const MAX_LINK_HOPS = 40;

/**
 * Where a path resolves, or would resolve once created: the real path when it
 * exists; otherwise a dangling final link is followed to its target, and a
 * missing name is joined onto its parent's prospective real path. Throws on
 * any error other than ENOENT/ENOTDIR, and after MAX_LINK_HOPS links.
 */
async function prospectiveRealPath(p: string, hops = 0): Promise<string> {
	if (hops > MAX_LINK_HOPS) {
		throw new Error(`More than ${MAX_LINK_HOPS} symlink hops.`);
	}
	try {
		return await realpath(p);
	} catch (err) {
		if (!isMissing(err)) throw err;
	}
	let isLink: boolean;
	try {
		isLink = (await lstat(p)).isSymbolicLink();
	} catch (err) {
		if (!isMissing(err)) throw err;
		const parent = dirname(p);
		if (parent === p) return p;
		return join(await prospectiveRealPath(parent, hops), basename(p));
	}
	if (!isLink) return p;
	return prospectiveRealPath(
		resolvePath(dirname(p), await readlink(p)),
		hops + 1,
	);
}

function isMissing(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Thrown when an exclusive create finds the path already taken. */
export class FileExistsError extends Error {
	readonly code = "EEXIST";
}

/**
 * An error whose message carries no caller-supplied value or note text, so it
 * is safe to return to any tier. Restricted tiers get a fixed message for any
 * error that is neither this nor a filesystem error.
 */
export class CallerError extends Error {}

/** Thrown when a read-modify-write finds the file changed since it was read. */
export class ConcurrentModificationError extends CallerError {}

/** Why a path was refused; carried for the refusal audit log, never the path. */
export type AccessRefusalKind =
	| "outside_root"
	| "symlink"
	| "dot_segment"
	| "non_md"
	| "instruction_file"
	| "protected_path"
	| "write_scope"
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
	/**
	 * When set, the only folders the tier may write under (vault-relative,
	 * exact case). Unset means anywhere the rest of the policy allows.
	 */
	writeDirs?: readonly string[] | undefined;
}

/**
 * Files agents load as instructions, including variants such as
 * `CLAUDE.local.md` and `AGENTS.override.md`; a restricted tier may not write
 * them anywhere.
 */
const INSTRUCTION_FILE =
	/^(claude|agents?|gemini|qwen|crush|conventions)(\.[^/]*)?\.md$/i;

type Intent = "read" | "write";

/** True when any segment of a vault-relative path starts with `.`. */
function hasDotSegment(rel: string): boolean {
	return (
		rel !== "" && rel.split(sep).some((segment) => segment.startsWith("."))
	);
}

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
		const hidden = hasDotSegment(rel);
		// Every tier, `full` included: no write may land in a hidden folder or
		// file. `.git/config` and `.obsidian/plugins/*` hold settings that run
		// code (in the backup container, or on every synced device).
		if (hidden && intent === "write") {
			throw new AccessRefusal(
				"Path policy refused (dot_segment): writes to hidden (dot) folders and files are not permitted.",
				"dot_segment",
			);
		}
		if (!this.policy) return;
		if (hidden) throw policyRefusal("dot_segment");
		if (intent === "read") return;
		if (extname(rel).toLowerCase() !== ".md") throw policyRefusal("non_md");
		// A folder named like a note (`X.md/y.md`) would block the note `X.md`
		// for every tier; restricted tiers may not create one.
		if (
			rel
				.split(sep)
				.slice(0, -1)
				.some((s) => s.toLowerCase().endsWith(".md"))
		) {
			throw policyRefusal("non_md");
		}
		if (INSTRUCTION_FILE.test(basename(rel))) {
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
		const dirs = this.policy.writeDirs;
		if (dirs && !dirs.some((d) => rel === d || rel.startsWith(d + sep))) {
			throw policyRefusal("write_scope");
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
		return (await this.resolveTarget(vaultRelPath, intent)).lexical;
	}

	/**
	 * resolveSafe's walk, returning both the lexical path and the real target
	 * (every in-vault link on the way resolved). Writes open `real` with
	 * O_NOFOLLOW, which refuses a link swapped in at the final component after
	 * this check; a swap of a parent folder is not covered.
	 */
	private async resolveTarget(
		vaultRelPath: string,
		intent: Intent,
	): Promise<{ lexical: string; real: string }> {
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
				// ENOENT: the rest does not exist yet. ENOTDIR: a file is used as a
				// directory, so nothing below it can exist. Either way no link lies ahead.
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") break;
				throw new AccessRefusal(
					"Path traversal rejected (unresolvable component).",
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
					"Path traversal rejected (dangling symlink escape).",
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
		const realTarget = join(current, ...parts.slice(walked));
		if (this.policy || intent === "write") {
			this.checkPolicy(relative(realRoot, realTarget), intent);
		}
		if (this.policy && intent === "write") {
			await this.checkProtectedTargets(realRoot, realTarget);
		}
		return { lexical: resolved, real: realTarget };
	}

	/**
	 * A protected path may itself be a link (`Templates/active.md` ->
	 * `Templates/base.md`), or sit under a linked folder; refuse a restricted
	 * write that reaches the file it resolves to, under any name. That file
	 * need not exist yet: a dangling template link, or a template under a linked
	 * folder, still names the file `daily_note` would read once it is created.
	 * Resolved per call, because a link can be repointed while the server runs.
	 * Hard links are not compared; making one needs filesystem access, not a tool.
	 */
	private async checkProtectedTargets(
		realRoot: string,
		realTarget: string,
	): Promise<void> {
		const target = relative(realRoot, realTarget).toLowerCase();
		for (const p of this.policy?.protectedPaths ?? []) {
			let protectedReal: string;
			try {
				protectedReal = await prospectiveRealPath(join(realRoot, normalize(p)));
			} catch {
				// A symlink loop, a permission error, or too many hops: the template's
				// file cannot be told apart from this one, so refuse the write.
				throw policyRefusal("protected_path");
			}
			if (relative(realRoot, protectedReal).toLowerCase() === target) {
				throw policyRefusal("protected_path");
			}
		}
	}

	/** Read a file's content. */
	async readFile(path: string): Promise<string> {
		return readFile(await this.resolveSafe(path), "utf-8");
	}

	/**
	 * Write (create or replace) a file, creating parent directories as needed.
	 * Refused under a path policy, which allows only create and append.
	 */
	async writeFile(path: string, content: string): Promise<void> {
		this.refuseWriteOperation();
		const { real } = await this.resolveTarget(path, "write");
		await mkdir(dirname(real), { recursive: true });
		await withPathLock(real, async () => {
			const handle = await openNoFollow(
				real,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
			);
			try {
				await handle.writeFile(content, "utf-8");
			} finally {
				await handle.close();
			}
		});
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
	 * Queued with updateIfUnchanged on the same note, so an in-process update
	 * cannot write back a snapshot taken before this append.
	 */
	async appendFile(path: string, content: string): Promise<void> {
		const { real } = await this.resolveTarget(path, "write");
		await withPathLock(real, async () => {
			const handle = await openNoFollow(
				real,
				fsConstants.O_WRONLY | fsConstants.O_APPEND,
			);
			try {
				await handle.writeFile(content, "utf-8");
			} finally {
				await handle.close();
			}
		});
	}

	/**
	 * Read, transform, and write back a file through one no-follow handle, so the
	 * read and the write reach the same file. In-process callers on the same note
	 * are queued (withPathLock). An outside writer is caught when its write
	 * changes the size or mtime while the note is read and transformed; a write
	 * that lands after the second stat is not detected.
	 */
	async updateIfUnchanged(
		path: string,
		transform: (content: string) => string,
	): Promise<void> {
		const { real } = await this.resolveTarget(path, "write");
		await withPathLock(real, async () => {
			const handle = await openNoFollow(real, fsConstants.O_RDWR);
			try {
				const before = await handle.stat();
				const updated = transform(await handle.readFile("utf-8"));
				const after = await handle.stat();
				if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
					throw new ConcurrentModificationError(
						"The note changed while it was being updated; retry the call.",
					);
				}
				await overwrite(handle, updated);
			} finally {
				await handle.close();
			}
		});
	}

	/** Delete a file. Refused under a path policy. */
	async deleteFile(path: string): Promise<void> {
		this.refuseWriteOperation();
		await unlink(await this.resolveSafe(path, "write"));
	}

	/** Rename/move a file. Refused under a path policy. */
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
			// A frontmatter block can parse to a YAML scalar or sequence; only a
			// mapping has properties (and `in` throws on a primitive).
			if (
				!frontmatter ||
				typeof frontmatter !== "object" ||
				Array.isArray(frontmatter) ||
				!(property in frontmatter)
			) {
				continue;
			}

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
			// Notes under a hidden folder are not writable by any tier; leave their
			// links as they are rather than failing the rename halfway.
			if (hasDotSegment(file.path)) continue;
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

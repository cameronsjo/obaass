import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultService } from "../../src/vault/vault-service.js";

/**
 * Containment: no VaultService entry point may read, write, create, delete,
 * rename, stat, or list anything outside the vault root.
 *
 * Layout per test:
 *   <root>/vault/            the vault
 *   <root>/vault-2/x.md      a sibling whose name shares the vault's prefix
 *   <root>/outside/          files a caller must never reach
 */
const REFUSED = /traversal|escape/i;

let root: string;
let vaultPath: string;
let outside: string;
let vault: VaultService;

async function listTree(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true });
	return entries.map(String).sort();
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "obaass-contain-"));
	vaultPath = join(root, "vault");
	outside = join(root, "outside");
	await mkdir(vaultPath);
	await mkdir(join(outside, "sub"), { recursive: true });
	await mkdir(join(root, "vault-2"));
	await writeFile(join(outside, "secret.txt"), "TOP SECRET");
	await writeFile(join(outside, "sub", "victim.md"), "VICTIM");
	await writeFile(join(root, "vault-2", "x.md"), "SIBLING");

	await writeFile(join(vaultPath, "real.md"), "real");
	await mkdir(join(vaultPath, "realdir"));
	await writeFile(join(vaultPath, "realdir", "inner.md"), "inner");

	// Escaping links.
	await symlink(join(outside, "secret.txt"), join(vaultPath, "leak.md"));
	await symlink(join(outside, "sub"), join(vaultPath, "linkdir"));
	await symlink(join(root, "vault-2", "x.md"), join(vaultPath, "sib.md"));
	await symlink(join(root, "vault-2"), join(vaultPath, "sibdir"));
	// Dangling links whose targets are outside and do not exist yet.
	await symlink(join(outside, "planted.md"), join(vaultPath, "dangle.md"));
	await symlink(join(outside, "newdir"), join(vaultPath, "dangledir"));
	// A chain: in-vault link -> in-vault link -> outside.
	await symlink(join(vaultPath, "hop2.md"), join(vaultPath, "hop1.md"));
	await symlink(join(outside, "secret.txt"), join(vaultPath, "hop2.md"));
	// Links that stay inside the vault are allowed.
	await symlink(join(vaultPath, "real.md"), join(vaultPath, "alias.md"));
	await symlink(join(vaultPath, "realdir"), join(vaultPath, "aliasdir"));

	vault = new VaultService(vaultPath);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const LEXICAL_ESCAPES = [
	"../escape.md",
	"a/../../escape.md",
	"realdir/../../escape.md",
	"..",
	"/etc/hosts",
	join(tmpdir(), "abs.md"),
];

const LINK_ESCAPES = [
	"leak.md",
	"linkdir/new.md",
	"sib.md",
	"sibdir/x.md",
	"dangle.md",
	"dangledir/x.md",
	"hop1.md",
];

describe("containment: lexical escapes", () => {
	it.each(LEXICAL_ESCAPES)("readFile refuses %s", async (p) => {
		await expect(vault.readFile(p)).rejects.toThrow(REFUSED);
	});

	it.each(LEXICAL_ESCAPES)("writeFile refuses %s", async (p) => {
		await expect(vault.writeFile(p, "x")).rejects.toThrow(REFUSED);
	});

	it.each(LEXICAL_ESCAPES)("createFile refuses %s", async (p) => {
		await expect(vault.createFile(p, "x")).rejects.toThrow(REFUSED);
	});

	it.each(LEXICAL_ESCAPES)("deleteFile refuses %s", async (p) => {
		await expect(vault.deleteFile(p)).rejects.toThrow(REFUSED);
	});

	it.each(LEXICAL_ESCAPES)("exists reports %s as absent", async (p) => {
		expect(await vault.exists(p)).toBe(false);
	});

	it.each(LEXICAL_ESCAPES)("stat refuses %s", async (p) => {
		await expect(vault.stat(p)).rejects.toThrow(REFUSED);
	});

	it.each(LEXICAL_ESCAPES)("getStructure refuses %s", async (p) => {
		await expect(vault.getStructure(p)).rejects.toThrow(REFUSED);
	});

	it.each(LEXICAL_ESCAPES)("renameFile refuses %s as either end", async (p) => {
		await expect(vault.renameFile("real.md", p)).rejects.toThrow(REFUSED);
		await expect(vault.renameFile(p, "moved.md")).rejects.toThrow(REFUSED);
		expect(await readFile(join(vaultPath, "real.md"), "utf-8")).toBe("real");
	});

	it("refuses a path with a NUL byte", async () => {
		await expect(vault.readFile("real.md\0.txt")).rejects.toThrow();
		await expect(vault.writeFile("x\0.md", "x")).rejects.toThrow();
	});

	it("normalizes .. inside the vault and never decodes percent-escapes", async () => {
		await vault.writeFile("realdir/../norm.md", "n");
		expect(await readFile(join(vaultPath, "norm.md"), "utf-8")).toBe("n");
		await expect(vault.readFile("realdir/../../x.md")).rejects.toThrow(REFUSED);
		await vault.writeFile("%2e%2e/x.md", "literal");
		expect(await readFile(join(vaultPath, "%2e%2e", "x.md"), "utf-8")).toBe(
			"literal",
		);
		expect(await listTree(outside)).not.toContain("x.md");
	});

	it("treats a file used as a directory as missing, not as an escape", async () => {
		await expect(vault.readFile("real.md/x.md")).rejects.toThrow(/ENOTDIR/);
		expect(await vault.exists("real.md/x.md")).toBe(false);
	});

	it("treats a name that merely starts with dots as inside the vault", async () => {
		await vault.writeFile("..notes.md", "ok");
		expect(await vault.readFile("..notes.md")).toBe("ok");
	});
});

describe("containment: symlinks", () => {
	it.each(LINK_ESCAPES)("readFile refuses %s", async (p) => {
		await expect(vault.readFile(p)).rejects.toThrow(REFUSED);
	});

	it.each(LINK_ESCAPES)(
		"writeFile refuses %s and leaves outside untouched",
		async (p) => {
			const before = await listTree(outside);
			await expect(vault.writeFile(p, "PWNED")).rejects.toThrow(REFUSED);
			expect(await listTree(outside)).toEqual(before);
			expect(await readFile(join(outside, "secret.txt"), "utf-8")).toBe(
				"TOP SECRET",
			);
		},
	);

	it.each(LINK_ESCAPES)(
		"createFile refuses %s and leaves outside untouched",
		async (p) => {
			const before = await listTree(outside);
			await expect(vault.createFile(p, "PWNED")).rejects.toThrow(REFUSED);
			expect(await listTree(outside)).toEqual(before);
		},
	);

	it.each(LINK_ESCAPES)("exists reports %s as absent", async (p) => {
		expect(await vault.exists(p)).toBe(false);
	});

	it.each(LINK_ESCAPES)(
		"appendFile and updateIfUnchanged refuse %s and leave outside untouched",
		async (p) => {
			const before = await listTree(outside);
			await expect(vault.appendFile(p, "PWNED")).rejects.toThrow(REFUSED);
			await expect(
				vault.updateIfUnchanged(p, (c) => `${c}PWNED`),
			).rejects.toThrow(REFUSED);
			expect(await listTree(outside)).toEqual(before);
			expect(await readFile(join(outside, "secret.txt"), "utf-8")).toBe(
				"TOP SECRET",
			);
		},
	);

	it.each(LINK_ESCAPES)(
		"deleteFile refuses %s and leaves outside untouched",
		async (p) => {
			const before = await listTree(outside);
			await expect(vault.deleteFile(p)).rejects.toThrow(REFUSED);
			expect(await listTree(outside)).toEqual(before);
		},
	);

	it.each(LINK_ESCAPES)("renameFile refuses %s as the source", async (p) => {
		const before = await listTree(outside);
		await expect(vault.renameFile(p, "moved.md")).rejects.toThrow(REFUSED);
		expect(await listTree(outside)).toEqual(before);
		expect(await vault.exists("moved.md")).toBe(false);
	});

	it("refuses reading, deleting, or renaming an existing outside file through a directory link", async () => {
		await expect(vault.readFile("linkdir/victim.md")).rejects.toThrow(REFUSED);
		await expect(vault.deleteFile("linkdir/victim.md")).rejects.toThrow(
			REFUSED,
		);
		await expect(
			vault.renameFile("linkdir/victim.md", "stolen.md"),
		).rejects.toThrow(REFUSED);
		expect(await readFile(join(outside, "sub", "victim.md"), "utf-8")).toBe(
			"VICTIM",
		);
	});

	it.each(LINK_ESCAPES)("stat refuses %s", async (p) => {
		await expect(vault.stat(p)).rejects.toThrow(REFUSED);
	});

	it("renameFile refuses moving a note into an escaping or dangling directory link", async () => {
		for (const dest of [
			"linkdir/moved.md",
			"dangledir/moved.md",
			"sibdir/moved.md",
		]) {
			await expect(vault.renameFile("real.md", dest)).rejects.toThrow(REFUSED);
		}
		expect(await readFile(join(vaultPath, "real.md"), "utf-8")).toBe("real");
		expect(await listTree(outside)).not.toContain("newdir");
	});

	it("getStructure refuses an escaping directory link", async () => {
		await expect(vault.getStructure("linkdir")).rejects.toThrow(REFUSED);
		await expect(vault.getStructure("dangledir")).rejects.toThrow(REFUSED);
		await expect(vault.getStructure("sibdir")).rejects.toThrow(REFUSED);
	});

	it("allows links that resolve inside the vault", async () => {
		expect(await vault.readFile("alias.md")).toBe("real");
		expect(await vault.readFile("aliasdir/inner.md")).toBe("inner");
		await vault.writeFile("aliasdir/new.md", "via alias");
		expect(await readFile(join(vaultPath, "realdir", "new.md"), "utf-8")).toBe(
			"via alias",
		);
	});
});

describe("createFile never replaces", () => {
	it("refuses an existing file and leaves its content", async () => {
		await expect(vault.createFile("real.md", "clobber")).rejects.toThrow(
			/exists/i,
		);
		expect(await readFile(join(vaultPath, "real.md"), "utf-8")).toBe("real");
	});

	it("refuses an existing in-vault symlink and leaves its target", async () => {
		await expect(vault.createFile("alias.md", "clobber")).rejects.toThrow(
			/exists/i,
		);
		expect(await readFile(join(vaultPath, "real.md"), "utf-8")).toBe("real");
	});

	it("creates a new file and its parent directories", async () => {
		await vault.createFile("new/dir/note.md", "fresh");
		expect(await readFile(join(vaultPath, "new/dir/note.md"), "utf-8")).toBe(
			"fresh",
		);
	});
});

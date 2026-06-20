import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultService } from "../../src/vault/vault-service.js";
import { cleanupVault, makeTempVault, writeVaultFile } from "../helpers.js";

describe("VaultService", () => {
	let vaultPath: string;
	let vault: VaultService;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		vault = new VaultService(vaultPath);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	describe("path traversal protection", () => {
		it("rejects parent-directory traversal", async () => {
			await expect(vault.readFile("../etc/hosts")).rejects.toThrow(
				/traversal/i,
			);
		});

		it("rejects nested parent traversal", async () => {
			await expect(vault.readFile("notes/../../escape.md")).rejects.toThrow(
				/traversal/i,
			);
		});

		it("rejects absolute paths", async () => {
			await expect(vault.readFile("/etc/hosts")).rejects.toThrow(/traversal/i);
		});

		it("allows legitimate vault-relative paths", async () => {
			await writeVaultFile(vaultPath, "folder/note.md", "hello");
			await expect(vault.readFile("folder/note.md")).resolves.toBe("hello");
		});

		// P0.1: a symlink inside the vault pointing OUTSIDE must be rejected on read.
		it("rejects reading through a symlink that escapes the vault", async () => {
			const outsideDir = await mkdtemp(join(tmpdir(), "obaass-outside-"));
			const secret = join(outsideDir, "secret.txt");
			await writeFile(secret, "TOP SECRET", "utf-8");
			// in-vault symlink -> outside file
			await symlink(secret, join(vaultPath, "leak.md"));

			await expect(vault.readFile("leak.md")).rejects.toThrow(
				/traversal|escape/i,
			);
			await cleanupVault(outsideDir);
		});

		it("rejects writing through a symlinked directory that escapes the vault", async () => {
			const outsideDir = await mkdtemp(join(tmpdir(), "obaass-outside-"));
			await mkdir(join(outsideDir, "sub"), { recursive: true });
			await symlink(join(outsideDir, "sub"), join(vaultPath, "linkdir"));

			await expect(vault.writeFile("linkdir/pwned.md", "x")).rejects.toThrow(
				/traversal|escape/i,
			);
			await cleanupVault(outsideDir);
		});
	});

	describe("readFile / writeFile / exists / deleteFile", () => {
		it("writes then reads a file, creating parent dirs", async () => {
			await vault.writeFile("a/b/c.md", "content");
			expect(await vault.exists("a/b/c.md")).toBe(true);
			expect(await vault.readFile("a/b/c.md")).toBe("content");
		});

		it("reports non-existent files as not existing", async () => {
			expect(await vault.exists("nope.md")).toBe(false);
		});

		it("deletes a file", async () => {
			await vault.writeFile("gone.md", "x");
			await vault.deleteFile("gone.md");
			expect(await vault.exists("gone.md")).toBe(false);
		});
	});

	describe("stat", () => {
		it("returns file metadata", async () => {
			await vault.writeFile("s.md", "hello world");
			const s = await vault.stat("s.md");
			expect(s.name).toBe("s.md");
			expect(s.extension).toBe(".md");
			expect(s.size).toBeGreaterThan(0);
			expect(s.mtimeMs).toBeGreaterThan(0);
		});
	});

	describe("listMarkdownFiles", () => {
		it("lists only markdown files and skips ignored dirs", async () => {
			await writeVaultFile(vaultPath, "one.md", "1");
			await writeVaultFile(vaultPath, "sub/two.md", "2");
			await writeVaultFile(vaultPath, "notes.txt", "not md");
			await writeVaultFile(vaultPath, ".obsidian/config.md", "ignored");
			await writeVaultFile(vaultPath, ".git/x.md", "ignored");

			const files = await vault.listMarkdownFiles();
			const paths = files.map((f) => f.path).sort();
			expect(paths).toEqual(["one.md", join("sub", "two.md")].sort());
		});
	});

	describe("getStructure", () => {
		it("returns a sorted tree with directories first", async () => {
			await writeVaultFile(vaultPath, "z.md", "z");
			await writeVaultFile(vaultPath, "adir/inner.md", "i");

			const tree = await vault.getStructure();
			expect(tree[0]).toMatchObject({ name: "adir", type: "directory" });
			expect(tree[0].children?.[0]).toMatchObject({
				name: "inner.md",
				type: "file",
			});
			expect(tree.find((e) => e.name === "z.md")).toMatchObject({
				type: "file",
			});
		});

		it("skips ignored directories in the tree", async () => {
			await writeVaultFile(vaultPath, ".git/x.md", "x");
			await writeVaultFile(vaultPath, "keep.md", "k");
			const tree = await vault.getStructure();
			expect(tree.find((e) => e.name === ".git")).toBeUndefined();
		});
	});

	describe("getMetadata", () => {
		it("extracts frontmatter, tags, headings, and wikilinks", async () => {
			await vault.writeFile(
				"meta.md",
				"---\nstatus: draft\ntags: [alpha]\n---\n# Title\n\n#beta text [[other note]]\n",
			);
			const m = await vault.getMetadata("meta.md");
			expect(m.frontmatter).toMatchObject({ status: "draft" });
			expect(m.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));
			expect(m.headings).toEqual([{ level: 1, text: "Title" }]);
			expect(m.wikilinks).toEqual([
				{ path: "other note", alias: undefined, heading: undefined },
			]);
		});
	});

	describe("searchContent", () => {
		beforeEach(async () => {
			await vault.writeFile("doc1.md", "alpha beta\ngamma\nALPHA again");
			await vault.writeFile("doc2.md", "nothing here");
		});

		it("finds case-insensitive matches by default", async () => {
			const results = await vault.searchContent("alpha");
			expect(results.length).toBe(2);
			expect(results.map((r) => r.line)).toEqual([1, 3]);
		});

		it("respects caseSensitive", async () => {
			const results = await vault.searchContent("ALPHA", {
				caseSensitive: true,
			});
			expect(results.length).toBe(1);
			expect(results[0].line).toBe(3);
		});

		it("supports regex queries", async () => {
			const results = await vault.searchContent("a.pha", { regex: true });
			expect(results.length).toBe(2);
		});

		it("resets lastIndex so global-regex matches are not skipped", async () => {
			// A global regex retains lastIndex between .test() calls; the service must reset it.
			const results = await vault.searchContent("a", { regex: true });
			// 'a' appears on multiple lines across both files; every matching line must be found.
			expect(results.length).toBeGreaterThanOrEqual(3);
		});

		it("honors maxResults", async () => {
			const results = await vault.searchContent("a", {
				regex: true,
				maxResults: 1,
			});
			expect(results.length).toBe(1);
		});

		it("clamps absurd maxResults instead of trusting the caller", async () => {
			const results = await vault.searchContent("alpha", {
				maxResults: 10_000_000,
			});
			expect(results.length).toBe(2);
		});
	});

	describe("getAllTags / findByTag", () => {
		beforeEach(async () => {
			await vault.writeFile("t1.md", "---\ntags: [shared, one]\n---\nbody");
			await vault.writeFile("t2.md", "#shared inline only");
		});

		it("counts tags across the vault", async () => {
			const tags = await vault.getAllTags();
			expect(tags.shared).toBe(2);
			expect(tags.one).toBe(1);
		});

		it("finds files by tag with or without #", async () => {
			expect((await vault.findByTag("shared")).sort()).toEqual([
				"t1.md",
				"t2.md",
			]);
			expect(await vault.findByTag("#one")).toEqual(["t1.md"]);
		});
	});

	describe("findByProperty", () => {
		beforeEach(async () => {
			await vault.writeFile("p1.md", "---\nstatus: done\n---\n");
			await vault.writeFile("p2.md", "---\nstatus: draft\n---\n");
			await vault.writeFile("p3.md", "---\nother: x\n---\n");
		});

		it("matches by property presence", async () => {
			const results = await vault.findByProperty("status");
			expect(results.map((r) => r.path).sort()).toEqual(["p1.md", "p2.md"]);
		});

		it("matches by property value", async () => {
			const results = await vault.findByProperty("status", "done");
			expect(results).toEqual([{ path: "p1.md", value: "done" }]);
		});
	});

	describe("getRecentFiles", () => {
		it("returns newest first and respects count", async () => {
			await vault.writeFile("old.md", "o");
			await new Promise((r) => setTimeout(r, 10));
			await vault.writeFile("new.md", "n");

			const recent = await vault.getRecentFiles(1);
			expect(recent.length).toBe(1);
			expect(recent[0].path).toBe("new.md");
		});

		it("clamps absurd count requests", async () => {
			await vault.writeFile("a.md", "a");
			const recent = await vault.getRecentFiles(10_000_000);
			expect(recent.length).toBe(1);
		});
	});

	describe("renameWithLinks", () => {
		it("renames a file and rewrites wikilinks vault-wide", async () => {
			await vault.writeFile("note.md", "original");
			await vault.writeFile("ref1.md", "see [[note]] here");
			await vault.writeFile(
				"ref2.md",
				"and [[note|aliased]] and [[note#heading]]",
			);
			await vault.writeFile("unrelated.md", "no links");

			const count = await vault.renameWithLinks("note.md", "renamed.md");

			expect(count).toBe(2);
			expect(await vault.exists("renamed.md")).toBe(true);
			expect(await vault.exists("note.md")).toBe(false);
			expect(await vault.readFile("ref1.md")).toBe("see [[renamed]] here");
			// alias + heading preserved
			expect(await vault.readFile("ref2.md")).toBe(
				"and [[renamed|aliased]] and [[renamed#heading]]",
			);
			expect(await vault.readFile("unrelated.md")).toBe("no links");
		});
	});

	describe("renameFile", () => {
		it("moves a file into a new (created) directory", async () => {
			await vault.writeFile("src.md", "x");
			await vault.renameFile("src.md", "deep/dst.md");
			expect(await vault.exists("deep/dst.md")).toBe(true);
			expect(await vault.exists("src.md")).toBe(false);
		});
	});
});

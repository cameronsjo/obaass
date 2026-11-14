import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackupClient } from "../../src/integrations/backup-client.js";
import { BackupToolProvider } from "../../src/tools/backup-tools.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import { cleanupVault, makeTempVault } from "../helpers.js";

/**
 * Backup tools against a real git repository (no child_process mock), so the
 * argv and environment git actually receives are what is tested.
 */
let vaultPath: string;
let provider: BackupToolProvider;
let head: string;

function git(...args: string[]): string {
	return execFileSync(
		"git",
		["-C", vaultPath, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ encoding: "utf-8" },
	).trim();
}

function tool(name: string): ToolDefinition {
	const found = provider.getTools().find((t) => t.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
}

beforeEach(async () => {
	vaultPath = await makeTempVault();
	git("init", "-q");
	await writeFile(join(vaultPath, "a.md"), "a v1");
	await writeFile(join(vaultPath, "b.md"), "b v1");
	git("add", "-A");
	git("commit", "-q", "-m", "v1");
	head = git("rev-parse", "HEAD");
	await writeFile(join(vaultPath, "a.md"), "a v2");
	await writeFile(join(vaultPath, "b.md"), "b v2");
	provider = new BackupToolProvider({} as BackupClient, vaultPath);
});

afterEach(async () => {
	await cleanupVault(vaultPath);
});

describe("backup tools treat paths literally", () => {
	it("backup_restore with a glob path restores nothing", async () => {
		await expect(
			tool("backup_restore").handler({ commit: head, path: "*" }),
		).rejects.toThrow(/pathspec/i);
		expect(await readFile(join(vaultPath, "a.md"), "utf-8")).toBe("a v2");
		expect(await readFile(join(vaultPath, "b.md"), "utf-8")).toBe("b v2");
	});

	it("backup_restore with pathspec magic restores nothing", async () => {
		await expect(
			tool("backup_restore").handler({ commit: head, path: ":(glob)*.md" }),
		).rejects.toThrow(/pathspec/i);
		expect(await readFile(join(vaultPath, "a.md"), "utf-8")).toBe("a v2");
	});

	it("backup_restore still restores a named file", async () => {
		await tool("backup_restore").handler({ commit: head, path: "a.md" });
		expect(await readFile(join(vaultPath, "a.md"), "utf-8")).toBe("a v1");
		expect(await readFile(join(vaultPath, "b.md"), "utf-8")).toBe("b v2");
	});

	it("backup_history with a glob file filter matches no file", async () => {
		const result = await tool("backup_history").handler({ file: "*" });
		expect(result.structuredContent).toMatchObject({ count: 0 });
		const named = await tool("backup_history").handler({ file: "a.md" });
		expect(named.structuredContent).toMatchObject({ count: 1 });
	});
});

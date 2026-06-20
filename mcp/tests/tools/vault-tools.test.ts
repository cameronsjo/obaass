import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import { VaultToolProvider } from "../../src/tools/vault-tools.js";
import { VaultService } from "../../src/vault/vault-service.js";
import { cleanupVault, makeTempVault, writeVaultFile } from "../helpers.js";

// Minimal config — only fill in what VaultToolProvider actually reads.
// The `as Config` cast intentionally bypasses loadConfig()'s Zod parse +
// path-existence check; tests own the vault path and should not invoke the
// real config loader, which is covered separately in config.test.ts.
function makeConfig(vaultPath: string): Config {
	return {
		vaultPath,
		httpPort: 3000,
		httpHost: "0.0.0.0",
		httpPath: "/mcp",
		logLevel: "info",
	} as Config;
}

/** Find a tool by name and assert it exists. */
function getTool(provider: VaultToolProvider, name: string): ToolDefinition {
	const tool = provider.getTools().find((t) => t.name === name);
	if (!tool) throw new Error(`Tool '${name}' not found in provider`);
	return tool;
}

/** Call a tool and return the first text content block. */
async function callTool(
	tool: ToolDefinition,
	params: Record<string, unknown>,
): Promise<string> {
	const result = await tool.handler(params);
	const block = result.content[0];
	if (block.type !== "text") throw new Error("expected text content");
	return block.text;
}

describe("VaultToolProvider — tool-name-set regression guard", () => {
	let provider: VaultToolProvider;

	beforeEach(async () => {
		const vault = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vault),
			makeConfig(vault),
		);
	});

	it("exposes the complete expected set of tool names", () => {
		const names = new Set(provider.getTools().map((t) => t.name));
		const required = [
			"read_note",
			"create_note",
			"append_to_note",
			"delete_note",
			"delete",
			"search_content",
			"vault_structure",
			"file_metadata",
			"vault_tags",
			"search_by_tag",
			"search_by_property",
			"recent_files",
			"set_frontmatter",
			"rename",
			"daily_note",
			"get_instructions",
		];
		for (const name of required) {
			expect(names, `missing tool: ${name}`).toContain(name);
		}
	});

	it("includes delete_note as the canonical delete tool", () => {
		expect(provider.getTools().map((t) => t.name)).toContain("delete_note");
	});

	it("includes 'delete' as a backward-compatibility alias alongside delete_note", () => {
		const toolNames = provider.getTools().map((t) => t.name);
		expect(toolNames).toContain("delete_note");
		expect(toolNames).toContain("delete");
	});
});

describe("VaultToolProvider — create_note", () => {
	let vaultPath: string;
	let provider: VaultToolProvider;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vaultPath),
			makeConfig(vaultPath),
		);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	it("creates a new file and confirms creation", async () => {
		const tool = getTool(provider, "create_note");
		const text = await callTool(tool, {
			path: "new-note.md",
			content: "hello world",
		});
		expect(text).toContain("new-note.md");
		const vault = new VaultService(vaultPath);
		expect(await vault.readFile("new-note.md")).toBe("hello world");
	});

	it("returns an Error: text when the file already exists and overwrite is not set", async () => {
		await writeVaultFile(vaultPath, "existing.md", "original");
		const tool = getTool(provider, "create_note");
		const text = await callTool(tool, {
			path: "existing.md",
			content: "replacement",
		});
		expect(text).toMatch(/error/i);
		expect(text).toContain("existing.md");
		// File should remain unchanged
		const vault = new VaultService(vaultPath);
		expect(await vault.readFile("existing.md")).toBe("original");
	});

	it("overwrites an existing file when overwrite:true", async () => {
		await writeVaultFile(vaultPath, "existing.md", "original");
		const tool = getTool(provider, "create_note");
		const text = await callTool(tool, {
			path: "existing.md",
			content: "replaced",
			overwrite: true,
		});
		expect(text).toContain("existing.md");
		const vault = new VaultService(vaultPath);
		expect(await vault.readFile("existing.md")).toBe("replaced");
	});
});

describe("VaultToolProvider — append_to_note", () => {
	let vaultPath: string;
	let provider: VaultToolProvider;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vaultPath),
			makeConfig(vaultPath),
		);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	it("appends content to the end of a note when no heading is given", async () => {
		await writeVaultFile(vaultPath, "note.md", "original content");
		const tool = getTool(provider, "append_to_note");
		await callTool(tool, { path: "note.md", content: "appended line" });
		const updated = await new VaultService(vaultPath).readFile("note.md");
		expect(updated).toContain("original content");
		expect(updated).toContain("appended line");
		// Appended content comes after original
		expect(updated.indexOf("original content")).toBeLessThan(
			updated.indexOf("appended line"),
		);
	});

	it("appends under a matching heading when heading is given", async () => {
		await writeVaultFile(vaultPath, "note.md", "## Section\n\nbody text");
		const tool = getTool(provider, "append_to_note");
		await callTool(tool, {
			path: "note.md",
			content: "new entry",
			heading: "Section",
		});
		const updated = await new VaultService(vaultPath).readFile("note.md");
		expect(updated).toContain("## Section");
		expect(updated).toContain("new entry");
		// New entry should appear after the heading
		expect(updated.indexOf("## Section")).toBeLessThan(
			updated.indexOf("new entry"),
		);
	});

	it("creates a new ## heading section when the given heading is absent", async () => {
		await writeVaultFile(vaultPath, "note.md", "# Title\n\nexisting body");
		const tool = getTool(provider, "append_to_note");
		await callTool(tool, {
			path: "note.md",
			content: "new content",
			heading: "New Section",
		});
		const updated = await new VaultService(vaultPath).readFile("note.md");
		expect(updated).toContain("## New Section");
		expect(updated).toContain("new content");
	});
});

describe("VaultToolProvider — delete_note and delete alias", () => {
	let vaultPath: string;
	let provider: VaultToolProvider;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vaultPath),
			makeConfig(vaultPath),
		);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	it("delete_note removes the file", async () => {
		await writeVaultFile(vaultPath, "to-delete.md", "content");
		const tool = getTool(provider, "delete_note");
		const text = await callTool(tool, { path: "to-delete.md" });
		expect(text).toContain("to-delete.md");
		expect(await new VaultService(vaultPath).exists("to-delete.md")).toBe(
			false,
		);
	});

	it("delete (alias) removes the file identically", async () => {
		await writeVaultFile(vaultPath, "to-delete-alias.md", "content");
		const tool = getTool(provider, "delete");
		const text = await callTool(tool, { path: "to-delete-alias.md" });
		expect(text).toContain("to-delete-alias.md");
		expect(await new VaultService(vaultPath).exists("to-delete-alias.md")).toBe(
			false,
		);
	});

	it("delete_note and delete share the same handler (same behaviour, different name)", async () => {
		await writeVaultFile(vaultPath, "a.md", "x");
		await writeVaultFile(vaultPath, "b.md", "y");

		const canonical = getTool(provider, "delete_note");
		const alias = getTool(provider, "delete");

		// Both delete their respective files cleanly
		await callTool(canonical, { path: "a.md" });
		await callTool(alias, { path: "b.md" });

		const vault = new VaultService(vaultPath);
		expect(await vault.exists("a.md")).toBe(false);
		expect(await vault.exists("b.md")).toBe(false);
	});
});

describe("VaultToolProvider — rename", () => {
	let vaultPath: string;
	let provider: VaultToolProvider;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vaultPath),
			makeConfig(vaultPath),
		);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	it("with updateLinks:true (default) renames the file and rewrites wikilinks", async () => {
		await writeVaultFile(vaultPath, "note.md", "original");
		await writeVaultFile(vaultPath, "ref.md", "see [[note]] for info");
		const tool = getTool(provider, "rename");
		const text = await callTool(tool, {
			oldPath: "note.md",
			newPath: "renamed.md",
		});
		// Result message should mention updated file count
		expect(text).toMatch(/updated \d+ file/i);

		const vault = new VaultService(vaultPath);
		expect(await vault.exists("renamed.md")).toBe(true);
		expect(await vault.exists("note.md")).toBe(false);
		expect(await vault.readFile("ref.md")).toBe("see [[renamed]] for info");
	});

	it("with updateLinks:false only moves the file and does not rewrite links", async () => {
		await writeVaultFile(vaultPath, "note.md", "original");
		await writeVaultFile(vaultPath, "ref.md", "see [[note]] here");
		const tool = getTool(provider, "rename");
		await callTool(tool, {
			oldPath: "note.md",
			newPath: "moved.md",
			updateLinks: false,
		});
		const vault = new VaultService(vaultPath);
		expect(await vault.exists("moved.md")).toBe(true);
		expect(await vault.exists("note.md")).toBe(false);
		// Wikilink in ref.md is NOT updated
		expect(await vault.readFile("ref.md")).toBe("see [[note]] here");
	});
});

describe("VaultToolProvider — daily_note", () => {
	let vaultPath: string;
	let provider: VaultToolProvider;
	const testDate = "2026-01-15";

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vaultPath),
			makeConfig(vaultPath),
		);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	it("creates today's daily note under 'Daily Notes' folder on first call", async () => {
		const tool = getTool(provider, "daily_note");
		const text = await callTool(tool, { date: testDate });
		expect(text).toContain(testDate);
		const vault = new VaultService(vaultPath);
		expect(await vault.exists(`Daily Notes/${testDate}.md`)).toBe(true);
	});

	it("returns the existing content on a second call (does not recreate)", async () => {
		const existingContent = "my pre-existing daily note";
		await writeVaultFile(
			vaultPath,
			`Daily Notes/${testDate}.md`,
			existingContent,
		);
		const tool = getTool(provider, "daily_note");
		const text = await callTool(tool, { date: testDate });
		expect(text).toBe(existingContent);
	});
});

describe("VaultToolProvider — set_frontmatter", () => {
	let vaultPath: string;
	let provider: VaultToolProvider;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vaultPath),
			makeConfig(vaultPath),
		);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	it("sets new frontmatter properties and preserves existing ones", async () => {
		await writeVaultFile(vaultPath, "note.md", "---\nstatus: draft\n---\nbody");
		const tool = getTool(provider, "set_frontmatter");
		const text = await callTool(tool, {
			path: "note.md",
			properties: { priority: "high" },
		});
		expect(text).toContain("note.md");

		const vault = new VaultService(vaultPath);
		const updated = await vault.readFile("note.md");
		const { parseNote } = await import("../../src/vault/frontmatter.js");
		const { frontmatter } = parseNote(updated);
		expect(frontmatter?.status).toBe("draft");
		expect(frontmatter?.priority).toBe("high");
	});

	it("sets frontmatter on a note with no existing frontmatter", async () => {
		await writeVaultFile(vaultPath, "plain.md", "just body text");
		const tool = getTool(provider, "set_frontmatter");
		await callTool(tool, {
			path: "plain.md",
			properties: { newProp: "value" },
		});

		const vault = new VaultService(vaultPath);
		const updated = await vault.readFile("plain.md");
		const { parseNote } = await import("../../src/vault/frontmatter.js");
		const { frontmatter } = parseNote(updated);
		expect(frontmatter?.newProp).toBe("value");
	});
});

describe("VaultToolProvider — recent_files", () => {
	let vaultPath: string;
	let provider: VaultToolProvider;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		provider = new VaultToolProvider(
			new VaultService(vaultPath),
			makeConfig(vaultPath),
		);
	});

	afterEach(async () => {
		await cleanupVault(vaultPath);
	});

	it("returns at most the requested count of files", async () => {
		await writeVaultFile(vaultPath, "a.md", "a");
		await writeVaultFile(vaultPath, "b.md", "b");
		await writeVaultFile(vaultPath, "c.md", "c");
		const tool = getTool(provider, "recent_files");
		const text = await callTool(tool, { count: 2 });
		const files = JSON.parse(text) as unknown[];
		expect(files.length).toBeLessThanOrEqual(2);
	});
});

import { execFile } from "node:child_process";
import { type Server, createServer } from "node:http";
import { promisify } from "node:util";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Config } from "../src/config.js";
import { BackupClient } from "../src/integrations/backup-client.js";
import { createMcpApp } from "../src/server.js";
import { BackupToolProvider } from "../src/tools/backup-tools.js";
import { ToolRegistry } from "../src/tools/index.js";
import { VaultToolProvider } from "../src/tools/vault-tools.js";
import { VaultService } from "../src/vault/vault-service.js";
import { cleanupVault, makeTempVault, writeVaultFile } from "./helpers.js";

const execFileAsync = promisify(execFile);
const health = { status: "healthy", uptime_seconds: 10 };

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

describe.each(["legacy", "modern"] as const)(
	"structured output over MCP HTTP (%s)",
	(era) => {
		let vaultPath: string;
		let server: Server;
		let backupServer: Server;
		let client: Client;
		let registry: ToolRegistry;
		let closeMcp: () => Promise<void>;
		let healthPayload: Record<string, unknown>;

		beforeEach(async () => {
			healthPayload = health;
			vaultPath = await makeTempVault();
			await writeVaultFile(
				vaultPath,
				"folder/note.md",
				"---\ntags: [test]\nrank: 2\n---\n# Note\nHello [[other]]\n",
			);
			await execFileAsync("git", ["init", vaultPath]);
			await execFileAsync("git", ["-C", vaultPath, "add", "."]);
			await execFileAsync("git", [
				"-C",
				vaultPath,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"-m",
				"Fixture",
			]);
			backupServer = createServer((_req, res) => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(healthPayload));
			});
			const backupUrl = await listen(backupServer);
			registry = new ToolRegistry();
			registry.register(
				new VaultToolProvider(new VaultService(vaultPath), {
					vaultPath,
				} as Config),
			);
			registry.register(
				new BackupToolProvider(new BackupClient(backupUrl), vaultPath),
			);
			registry.register({
				id: "invalid-output",
				name: "Invalid output fixtures",
				getTools: () => [
					{
						name: "invalid_output",
						description: "Return data that fails its output schema.",
						inputSchema: z.object({}),
						outputSchema: z.object({ count: z.number() }),
						handler: async () => ({
							content: [],
							structuredContent: { count: "wrong" },
						}),
					},
				],
			});
			const { app, close } = createMcpApp(registry, "/mcp");
			closeMcp = close;
			server = createServer(app);
			const baseUrl = await listen(server);
			client = new Client(
				{ name: "structured-output-test", version: "1.0.0" },
				{
					versionNegotiation: {
						mode: era === "modern" ? { pin: "2026-07-28" } : "legacy",
					},
				},
			);
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)),
			);
		});

		afterEach(async () => {
			await client.close();
			await closeMcp();
			await Promise.all(
				[server, backupServer].map(
					(s) => new Promise<void>((resolve) => s.close(() => resolve())),
				),
			);
			await cleanupVault(vaultPath);
		});

		it("advertises readOnlyHint from each tool's read-only classification", async () => {
			const { tools } = await client.listTools();
			const hint = (name: string) =>
				tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint;
			expect(hint("read_note")).toBe(true);
			expect(hint("backup_status")).toBe(true);
			expect(hint("create_note")).toBe(false);
			expect(hint("backup_restore")).toBe(false);
		});

		it("accepts health field drift and omitted optional uptime", async () => {
			healthPayload = {
				status: "healthy",
				pipeline: { state: "idle" },
				sync_state: ["synced"],
				last_commit: { hash: "abc1234" },
			};
			await client.listTools();
			const result = await client.callTool({
				name: "backup_status",
				arguments: {},
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual(healthPayload);
			const content = result.content as Array<{ type: string; text: string }>;
			expect(JSON.parse(content[0].text)).toEqual(healthPayload);
		});

		it.each([
			["search_content", { query: "Hello" }, undefined],
			["vault_structure", {}, "entries"],
			["file_metadata", { path: "folder/note.md" }, undefined],
			["vault_tags", {}, undefined],
			["search_by_tag", { tag: "test" }, undefined],
			["search_by_property", { property: "rank" }, undefined],
			["recent_files", {}, "files"],
			["backup_status", {}, undefined],
			["backup_history", {}, undefined],
		] as const)(
			"%s advertises and returns valid structured output without changing text",
			async (name, args, wrapper) => {
				const { tools } = await client.listTools();
				const advertised = tools.find((tool) => tool.name === name);
				expect(advertised?.outputSchema?.type).toBe("object");
				const result = await client.callTool({ name, arguments: args });
				expect(result.isError).not.toBe(true);
				expect(result.structuredContent).toBeDefined();
				const definition = registry.findTool(name);
				expect(
					definition?.outputSchema?.safeParse(result.structuredContent).success,
				).toBe(true);
				const content = result.content as Array<{ type: string; text: string }>;
				expect(content[0].type).toBe("text");
				const textData = JSON.parse(content[0].text);
				expect(
					wrapper
						? result.structuredContent?.[wrapper]
						: result.structuredContent,
				).toEqual(textData);
				if (name === "backup_status")
					expect(result.structuredContent).toEqual(health);
				if (name === "backup_history")
					expect(result.structuredContent?.count).toBe(1);
			},
		);

		it.each([
			["hello", "hello"],
			["- one\n- two", ["one", "two"]],
		])("preserves non-object YAML frontmatter: %s", async (yaml, expected) => {
			await writeVaultFile(
				vaultPath,
				"non-object.md",
				`---\n${yaml}\n---\nbody\n`,
			);
			const result = await client.callTool({
				name: "file_metadata",
				arguments: { path: "non-object.md" },
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent?.frontmatter).toEqual(expected);
			const content = result.content as Array<{ type: string; text: string }>;
			expect(JSON.parse(content[0].text).frontmatter).toEqual(expected);
		});

		it("rejects malformed output instead of reporting a successful tool call", async () => {
			const result = await client.callTool({
				name: "invalid_output",
				arguments: {},
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toBeUndefined();
			expect(result.content).toEqual([
				{ type: "text", text: expect.stringMatching(/output.*validation/i) },
			]);
		});

		it("preserves isError behavior for a structured tool whose handler throws", async () => {
			const result = await client.callTool({
				name: "file_metadata",
				arguments: { path: "missing.md" },
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toBeUndefined();
		});
	},
);

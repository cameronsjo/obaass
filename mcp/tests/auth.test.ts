import { type Server, request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	MIN_AUTH_TOKEN_LENGTH,
	isLoopbackHost,
	resolveAccessPolicy,
	tokensMatch,
} from "../src/auth.js";
import type { Config } from "../src/config.js";
import type { BackupClient } from "../src/integrations/backup-client.js";
import type { PluginClient } from "../src/integrations/plugin-client.js";
import { type McpAppOptions, createMcpApp } from "../src/server.js";
import { BackupToolProvider } from "../src/tools/backup-tools.js";
import { ToolRegistry } from "../src/tools/index.js";
import { PluginToolProvider } from "../src/tools/plugin-tools.js";
import { VaultToolProvider } from "../src/tools/vault-tools.js";
import type { VaultService } from "../src/vault/vault-service.js";

const TOKEN = "t".repeat(MIN_AUTH_TOKEN_LENGTH);

describe("isLoopbackHost", () => {
	it.each([
		"127.0.0.1",
		"127.8.9.10",
		"::1",
		"[::1]",
		"localhost",
		"LOCALHOST",
	])("treats %s as loopback", (host) =>
		expect(isLoopbackHost(host)).toBe(true),
	);
	it.each([
		"0.0.0.0",
		"::",
		"192.168.1.10",
		"100.100.100.100",
		"vault.example.ts.net",
		"localhost.evil.invalid",
		"::ffff:192.168.1.10",
		"",
	])("treats %s as reachable beyond loopback", (host) =>
		expect(isLoopbackHost(host)).toBe(false),
	);
});

describe("resolveAccessPolicy", () => {
	it("leaves a loopback bind with no token open, with write tools", () => {
		expect(
			resolveAccessPolicy({
				httpHost: "127.0.0.1",
				allowUnauthenticated: false,
			}),
		).toEqual({ authToken: undefined, readOnly: false, warning: undefined });
	});
	it("requires the token whenever one is set, on any bind", () => {
		for (const httpHost of ["127.0.0.1", "0.0.0.0"]) {
			expect(
				resolveAccessPolicy({
					httpHost,
					authToken: TOKEN,
					allowUnauthenticated: false,
				}),
			).toEqual({ authToken: TOKEN, readOnly: false, warning: undefined });
		}
	});
	it("refuses a non-loopback bind with no token", () => {
		expect(() =>
			resolveAccessPolicy({ httpHost: "0.0.0.0", allowUnauthenticated: false }),
		).toThrow(/MCP_AUTH_TOKEN.*MCP_ALLOW_UNAUTHENTICATED/s);
	});
	it("starts read-only with a warning when the operator opts out", () => {
		const policy = resolveAccessPolicy({
			httpHost: "0.0.0.0",
			allowUnauthenticated: true,
		});
		expect(policy.authToken).toBeUndefined();
		expect(policy.readOnly).toBe(true);
		expect(policy.warning).toMatch(/read-only/);
	});
});

describe("read-only tool classification", () => {
	it("serves exactly the non-mutating tools in read-only mode", () => {
		const registry = new ToolRegistry();
		const config = { vaultPath: "/vault" } as Config;
		registry.register(new VaultToolProvider({} as VaultService, config));
		registry.register(new BackupToolProvider({} as BackupClient, "/vault"));
		registry.register(new PluginToolProvider({} as PluginClient));
		const served = registry.getServedTools(true).map((t) => t.name);
		const withheld = registry
			.getAllTools()
			.map((t) => t.name)
			.filter((name) => !served.includes(name));
		expect(withheld.sort()).toEqual(
			[
				"append_to_note",
				"backup_restore",
				"create_note",
				"daily_note",
				"delete",
				"delete_note",
				"rename",
				"set_frontmatter",
			].sort(),
		);
		expect(registry.getServedTools(false)).toHaveLength(
			registry.getAllTools().length,
		);
	});
});

describe("tokensMatch", () => {
	it("matches only the identical token", () => {
		expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
		expect(tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false);
		expect(tokensMatch(TOKEN.slice(1), TOKEN)).toBe(false);
		expect(tokensMatch("", TOKEN)).toBe(false);
		expect(tokensMatch(`${TOKEN.slice(0, -1)}u`, TOKEN)).toBe(false);
	});
});

describe("MCP bearer auth and read-only mode over real HTTP", () => {
	let server: Server;
	let port: number;
	let closeMcp: () => Promise<void>;
	let echo: ReturnType<typeof vi.fn>;
	let write: ReturnType<typeof vi.fn>;
	let registry: ToolRegistry;

	async function start(options: McpAppOptions) {
		const { app, close } = createMcpApp(registry, "/mcp", options);
		closeMcp = close;
		app.get("/health", (_req, res) => {
			res.json({ status: "ok" });
		});
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No test port");
		port = address.port;
	}

	function send(
		method: string,
		path: string,
		headers: Record<string, string>,
		body?: string,
	) {
		return new Promise<{
			status: number;
			headers: Record<string, unknown>;
			body: string;
		}>((resolve, reject) => {
			const req = request(
				`http://127.0.0.1:${port}${path}`,
				{ method, headers, agent: false },
				(res) => {
					res.setEncoding("utf8");
					const chunks: string[] = [];
					res.on("data", (chunk: string) => chunks.push(chunk));
					res.on("error", reject);
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							body: chunks.join(""),
						}),
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	}

	function callTool(name: string, headers: Record<string, string> = {}) {
		return send(
			"POST",
			"/mcp",
			{
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "tools/call",
				"Mcp-Name": name,
				...headers,
			},
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name,
					arguments: {},
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
						"io.modelcontextprotocol/clientInfo": {
							name: "auth-test",
							version: "1",
						},
					},
				},
			}),
		);
	}

	beforeEach(() => {
		vi.stubEnv("MCP_ALLOWED_HOSTS", "");
		echo = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "read" }],
		}));
		write = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "wrote" }],
		}));
		registry = new ToolRegistry();
		registry.register({
			id: "fixture",
			name: "Auth fixture",
			getTools: () => [
				{
					name: "echo",
					description: "read fixture",
					readOnly: true,
					inputSchema: z.object({}),
					handler: echo,
				},
				{
					name: "write",
					description: "write fixture (unmarked, so treated as a write)",
					inputSchema: z.object({}),
					handler: write,
				},
			],
		});
	});
	afterEach(async () => {
		await closeMcp();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.unstubAllEnvs();
	});

	describe("with a token", () => {
		beforeEach(() => start({ authToken: TOKEN }));

		it("dispatches a write tool with the correct bearer token", async () => {
			const res = await callTool("write", { Authorization: `Bearer ${TOKEN}` });
			expect(res.status).toBe(200);
			expect(JSON.parse(res.body)).toMatchObject({
				result: { content: [{ text: "wrote" }] },
			});
			expect(write).toHaveBeenCalledOnce();
		});
		it("accepts a case-insensitive Bearer scheme", async () => {
			const res = await callTool("echo", { Authorization: `bearer ${TOKEN}` });
			expect(res.status).toBe(200);
		});
		it.each([
			["missing", undefined],
			["wrong token", `Bearer ${TOKEN.slice(0, -1)}x`],
			["wrong scheme", `Basic ${TOKEN}`],
			["empty bearer", "Bearer "],
			["token as prefix", `Bearer ${TOKEN}${TOKEN}`],
		])(
			"rejects %s credentials with 401 before dispatch",
			async (_label, value) => {
				const res = await callTool(
					"write",
					value ? { Authorization: value } : {},
				);
				expect(res.status).toBe(401);
				expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
				expect(JSON.parse(res.body)).toMatchObject({
					error: { message: expect.stringMatching(/bearer token/i) },
				});
				expect(write).not.toHaveBeenCalled();
				expect(echo).not.toHaveBeenCalled();
			},
		);
		it("rejects before JSON parsing", async () => {
			const res = await send(
				"POST",
				"/mcp",
				{ "content-type": "application/json" },
				"{ malformed",
			);
			expect(res.status).toBe(401);
		});
		it("guards a differently cased MCP path too", async () => {
			const res = await send("POST", "/MCP", {
				"content-type": "application/json",
			});
			expect(res.status).toBe(401);
		});
		it("leaves /health unauthenticated", async () => {
			const res = await send("GET", "/health", {});
			expect(res.status).toBe(200);
		});
	});

	describe("without a token (loopback open)", () => {
		beforeEach(() => start({}));

		it("dispatches write tools with no credential", async () => {
			const res = await callTool("write");
			expect(res.status).toBe(200);
			expect(write).toHaveBeenCalledOnce();
		});
	});

	describe("read-only (unauthenticated opt-out)", () => {
		beforeEach(() => start({ readOnly: true }));

		it("still serves read-only tools", async () => {
			const res = await callTool("echo");
			expect(res.status).toBe(200);
			expect(echo).toHaveBeenCalledOnce();
		});
		it("does not expose tools that are not marked read-only", async () => {
			const res = await callTool("write");
			const body = JSON.parse(res.body);
			const text = JSON.stringify(body);
			expect(text).toMatch(/write/);
			expect(body.result?.content?.[0]?.text).not.toBe("wrote");
			expect(write).not.toHaveBeenCalled();
		});
	});
});

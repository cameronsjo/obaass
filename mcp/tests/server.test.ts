import type { Server } from "node:http";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpApp } from "../src/server.js";
import { ToolRegistry } from "../src/tools/index.js";
import type { ToolDefinition, ToolProvider } from "../src/tools/types.js";

const MCP_PATH = "/mcp";

/** Minimal provider with a healthy tool and one that always throws. */
class FixtureProvider implements ToolProvider {
	id = "fixture";
	name = "Fixture";
	getTools(): ToolDefinition[] {
		return [
			{
				name: "echo",
				description: "Echo the input message back.",
				inputSchema: z.object({ message: z.string() }),
				handler: async (params) => ({
					content: [
						{
							type: "text",
							text: String((params as { message: string }).message),
						},
					],
				}),
			},
			{
				name: "boom",
				description: "Always throws.",
				inputSchema: z.object({ secret: z.string() }),
				handler: async () => {
					throw new Error("kaboom");
				},
			},
		];
	}
}

describe("createMcpApp HTTP server", () => {
	let server: Server;
	let baseUrl: string;
	let closeMcp: () => Promise<void>;

	beforeEach(async () => {
		const registry = new ToolRegistry();
		registry.register(new FixtureProvider());
		const { app, close } = createMcpApp(registry, MCP_PATH);
		closeMcp = close;
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		const addr = server.address();
		if (addr === null || typeof addr === "string") throw new Error("no port");
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterEach(async () => {
		await closeMcp();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("rejects GET on the MCP endpoint with 405", async () => {
		const res = await fetch(`${baseUrl}${MCP_PATH}`, { method: "GET" });
		expect(res.status).toBe(405);
		const body = (await res.json()) as { error?: { message?: string } };
		expect(body.error?.message).toMatch(/not allowed/i);
	});

	it("rejects DELETE on the MCP endpoint with 405", async () => {
		const res = await fetch(`${baseUrl}${MCP_PATH}`, { method: "DELETE" });
		expect(res.status).toBe(405);
	});

	it("rejects modern subscription streams because the app publishes no events", async () => {
		const res = await fetch(`${baseUrl}${MCP_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "subscriptions/listen",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 9,
				method: "subscriptions/listen",
				params: {
					notifications: { toolsListChanged: true },
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
						"io.modelcontextprotocol/clientInfo": {
							name: "subscription-probe",
							version: "1.0.0",
						},
					},
				},
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toMatchObject({
			id: 9,
			error: { code: -32603, message: "Subscription limit reached" },
		});
		const client = await connectClient(baseUrl);
		try {
			expect(
				(await client.listTools()).tools.map((tool) => tool.name),
			).toContain("echo");
		} finally {
			await client.close();
		}
	});

	it("retains the existing 100 KiB JSON body limit with the SDK adapter", async () => {
		const res = await fetch(`${baseUrl}${MCP_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "echo",
					arguments: { message: "x".repeat(100 * 1024) },
				},
			}),
		});
		expect(res.status).toBe(413);
		const client = await connectClient(baseUrl);
		try {
			expect(
				(await client.listTools()).tools.map((tool) => tool.name),
			).toContain("echo");
		} finally {
			await client.close();
		}
	});

	it("does not crash on a malformed JSON-RPC POST and keeps serving", async () => {
		const res = await fetch(`${baseUrl}${MCP_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ not: "a valid jsonrpc message" }),
		});
		// The transport rejects it (4xx/5xx) but must not crash the process.
		expect(res.status).toBeGreaterThanOrEqual(400);

		// A subsequent valid handshake still succeeds — proves the server is alive.
		const client = await connectClient(baseUrl);
		const tools = await client.listTools();
		expect(tools.tools.length).toBeGreaterThan(0);
		await client.close();
	});

	it("lists registered tools over the MCP handshake", async () => {
		const client = await connectClient(baseUrl);
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("echo");
		expect(names).toContain("boom");
		await client.close();
	});

	it("serves 2026-07-28 per-request context without initialize or a session ID", async () => {
		const exchanges: Array<{
			method: string;
			headers: Headers;
			meta: unknown;
			session: string | null;
		}> = [];
		const client = new Client(
			{ name: "modern-test", version: "1.0.0" },
			{
				versionNegotiation: { mode: { pin: "2026-07-28" } },
			},
		);
		const transport = new StreamableHTTPClientTransport(
			new URL(`${baseUrl}${MCP_PATH}`),
			{
				fetch: async (url, init) => {
					const response = await fetch(url, init);
					if (init?.body && typeof init.body === "string") {
						const body = JSON.parse(init.body);
						exchanges.push({
							method: body.method,
							headers: new Headers(init.headers),
							meta: body.params?._meta,
							session: response.headers.get("Mcp-Session-Id"),
						});
					}
					return response;
				},
			},
		);
		try {
			await client.connect(transport);
			expect(client.getProtocolEra()).toBe("modern");
			const result = await client.listTools();
			expect(result.tools.map((tool) => tool.name)).toContain("echo");
			expect(result.ttlMs).toBe(0);
			expect(result.cacheScope).toBe("private");
			const echoed = await client.callTool({
				name: "echo",
				arguments: { message: "modern" },
			});
			expect(echoed.content).toEqual([{ type: "text", text: "modern" }]);
			expect(exchanges.map((exchange) => exchange.method)).not.toContain(
				"initialize",
			);
			const call = exchanges.find(
				(exchange) => exchange.method === "tools/call",
			);
			expect(call?.headers.get("Mcp-Method")).toBe("tools/call");
			expect(call?.headers.get("Mcp-Name")).toBe("echo");
			expect(call?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
			expect(call?.meta).toMatchObject({
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			});
			expect(exchanges.every((exchange) => exchange.session === null)).toBe(
				true,
			);
		} finally {
			await client.close();
		}
	});

	it("returns an enriched isError result (tool name + arg keys, no values) on handler throw", async () => {
		const client = await connectClient(baseUrl);
		const result = (await client.callTool({
			name: "boom",
			arguments: { secret: "hunter2" },
		})) as {
			isError?: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(result.isError).toBe(true);
		const text = result.content[0].text;
		expect(text).toContain("boom");
		expect(text).toContain("kaboom");
		expect(text).toContain("secret"); // key is surfaced
		expect(text).not.toContain("hunter2"); // value is NOT leaked
		await client.close();
	});
});

async function connectClient(baseUrl: string): Promise<Client> {
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(
		new URL(`${baseUrl}${MCP_PATH}`),
	);
	await client.connect(transport);
	return client;
}

import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

	beforeEach(async () => {
		const registry = new ToolRegistry();
		registry.register(new FixtureProvider());
		const { app } = createMcpApp(registry, MCP_PATH);
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		const addr = server.address();
		if (addr === null || typeof addr === "string") throw new Error("no port");
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterEach(async () => {
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

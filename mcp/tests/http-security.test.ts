import { type Server, request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpApp } from "../src/server.js";
import { ToolRegistry } from "../src/tools/index.js";

describe("SDK Host and Origin validation over real HTTP", () => {
	let server: Server;
	let port: number;
	let registry: ToolRegistry;
	let closeMcp: () => Promise<void>;
	let calls: ReturnType<typeof vi.fn>;
	let receivedHost: string | undefined;

	async function start() {
		const { app, close } = createMcpApp(registry, "/mcp");
		closeMcp = close;
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No test port");
		port = address.port;
		server.on("request", (req) => {
			receivedHost = req.headers.host;
		});
	}
	async function stop() {
		await closeMcp();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	async function post(headers: Record<string, string>, body: string) {
		const response = await new Promise<{
			status: number;
			json: () => Promise<unknown>;
		}>((resolve, reject) => {
			const req = request(
				`http://127.0.0.1:${port}/mcp`,
				{ method: "POST", headers, agent: false },
				(res) => {
					res.setEncoding("utf8");
					const chunks: string[] = [];
					res.on("data", (chunk: string) => chunks.push(chunk));
					res.on("error", reject);
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							json: async () => JSON.parse(chunks.join("")),
						}),
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
		expect(receivedHost).toBe(
			headers.Host ?? headers.host ?? `127.0.0.1:${port}`,
		);
		return response;
	}
	async function call(headers: Record<string, string> = {}) {
		return post(
			{
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "tools/call",
				"Mcp-Name": "echo",
				...headers,
			},
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "echo",
					arguments: {},
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
						"io.modelcontextprotocol/clientInfo": {
							name: "guard-test",
							version: "1",
						},
					},
				},
			}),
		);
	}

	beforeEach(async () => {
		vi.stubEnv("MCP_ALLOWED_HOSTS", "");
		calls = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "accepted" }],
		}));
		registry = new ToolRegistry();
		registry.register({
			id: "guard",
			name: "Guard fixture",
			getTools: () => [
				{
					name: "echo",
					description: "Guard fixture",
					inputSchema: z.object({}),
					handler: calls,
				},
			],
		});
		await start();
	});
	afterEach(async () => {
		await stop();
		vi.unstubAllEnvs();
	});

	it.each(["localhost", "127.0.0.1", "[::1]"])(
		"allows %s at the bound port and its matching origin",
		async (hostname) => {
			const response = await call({
				Host: `${hostname}:${port}`,
				Origin: `http://${hostname}:${port}`,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				result: { content: [{ type: "text", text: "accepted" }] },
			});
			expect(calls).toHaveBeenCalledOnce();
		},
	);
	it("allows non-browser clients without Origin", async () => {
		expect((await call()).status).toBe(200);
		expect(calls).toHaveBeenCalledOnce();
	});
	it("rejects a bad Host through the SDK guard, even with spoofed forwarding headers", async () => {
		const response = await call({
			Host: `evil.invalid:${port}`,
			"X-Forwarded-Host": `localhost:${port}`,
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: -32000, message: expect.stringMatching(/Invalid Host/) },
		});
		expect(calls).not.toHaveBeenCalled();
	});
	it("rejects a cross-site Origin through the SDK guard", async () => {
		const response = await call({ Origin: `https://evil.invalid:${port}` });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: -32000, message: expect.stringMatching(/Invalid Origin/) },
		});
		expect(calls).not.toHaveBeenCalled();
	});
	it("does not treat the SDK's port-agnostic Host check as a port allowance", async () => {
		const response = await call({
			Host: `localhost:${port === 65535 ? 65534 : port + 1}`,
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { message: expect.stringMatching(/Host authority.*port/) },
		});
		expect(calls).not.toHaveBeenCalled();
	});
	it.each(["other-port", "other-scheme", "path", "credentials", "opaque"])(
		"rejects a non-matching Origin: %s",
		async (kind) => {
			const origins: Record<string, string> = {
				"other-port": `http://localhost:${port === 65535 ? 65534 : port + 1}`,
				"other-scheme": `https://localhost:${port}`,
				path: `http://localhost:${port}/path`,
				credentials: `http://user@localhost:${port}`,
				opaque: "null",
			};
			const response = await call({ Origin: origins[kind] });
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { message: expect.stringMatching(/Origin/) },
			});
			expect(calls).not.toHaveBeenCalled();
		},
	);
	it("rejects before JSON parsing or dispatch", async () => {
		const response = await post(
			{
				Host: `evil.invalid:${port}`,
				"content-type": "application/json",
			},
			"{ malformed",
		);
		expect(response.status).toBe(403);
		expect(calls).not.toHaveBeenCalled();
	});
	it("admits an explicit LAN/Tailscale hostname from the environment", async () => {
		await stop();
		vi.stubEnv("MCP_ALLOWED_HOSTS", " vault.example.ts.net , 100.100.100.100 ");
		await start();
		for (const hostname of ["vault.example.ts.net", "100.100.100.100"]) {
			const response = await call({
				Host: `${hostname}:${port}`,
				Origin: `http://${hostname}:${port}`,
			});
			expect(response.status).toBe(200);
		}
		expect(calls).toHaveBeenCalledTimes(2);
	});
	it("admits an explicit HTTPS proxy origin without trusting forwarded headers", async () => {
		await stop();
		vi.stubEnv(
			"MCP_ALLOWED_HOSTS",
			"https://vault.example.ts.net, http://lan.example:8080/",
		);
		await start();
		for (const [host, origin] of [
			["vault.example.ts.net", "https://vault.example.ts.net"],
			["lan.example:8080", "http://lan.example:8080"],
		]) {
			expect((await call({ Host: host, Origin: origin })).status).toBe(200);
		}
		expect(
			(
				await call({
					Host: "vault.example.ts.net:80",
					Origin: "https://vault.example.ts.net",
				})
			).status,
		).toBe(403);
		expect(calls).toHaveBeenCalledTimes(2);
	});
	it.each([
		"*",
		"http://*",
		"bad/path",
		"user@host",
		"host:",
		"host:0",
		"host:65536",
		"https://host/path",
		"https://host?query",
	])("fails startup for invalid allowlist entry %s", (entry) => {
		vi.stubEnv("MCP_ALLOWED_HOSTS", entry);
		expect(() => createMcpApp(registry, "/mcp")).toThrow(/MCP_ALLOWED_HOSTS/);
	});
});

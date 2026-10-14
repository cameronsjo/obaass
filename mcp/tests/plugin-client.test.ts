import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PluginClient } from "../src/integrations/plugin-client.js";
import { createMcpApp } from "../src/server.js";
import { ToolRegistry } from "../src/tools/index.js";

describe("PluginClient with the v2 SDK over real HTTP", () => {
	let server: Server;
	let plugin: PluginClient;
	let closeMcp: () => Promise<void>;
	let calls: ReturnType<typeof vi.fn>;
	let methods: string[];

	beforeEach(async () => {
		calls = vi.fn(async (params: Record<string, unknown>) => ({
			content: [{ type: "text" as const, text: `plugin:${params.message}` }],
		}));
		const registry = new ToolRegistry();
		registry.register({
			id: "plugin",
			name: "Plugin fixture",
			getTools: () => [
				{
					name: "echo",
					description: "Echo through the plugin",
					inputSchema: z.object({ message: z.string() }),
					handler: calls,
				},
			],
		});
		const { app, close } = createMcpApp(registry, "/mcp");
		closeMcp = close;
		methods = [];
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		server.on("request", (req) => {
			const chunks: Buffer[] = [];
			req.on("data", (data: Buffer) => chunks.push(data));
			req.on("end", () => {
				if (chunks.length)
					methods.push(JSON.parse(Buffer.concat(chunks).toString()).method);
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		plugin = new PluginClient(`http://127.0.0.1:${address.port}/mcp`);
	});

	afterEach(async () => {
		await plugin.disconnect();
		await closeMcp();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("connects, lists tools for health, calls a tool, disconnects and reconnects", async () => {
		expect(await plugin.isHealthy()).toBe(true);
		await plugin.connect();
		expect(await plugin.callTool("echo", { message: "hello" })).toBe(
			"plugin:hello",
		);
		expect(calls).toHaveBeenCalledWith({ message: "hello" });
		expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
		expect(methods).toContain("tools/list");
		expect(methods).toContain("tools/call");
		await plugin.disconnect();
		expect(await plugin.callTool("echo", { message: "again" })).toBe(
			"plugin:again",
		);
		expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
	});
});

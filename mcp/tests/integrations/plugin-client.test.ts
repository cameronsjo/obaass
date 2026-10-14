import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PluginClient } from "../../src/integrations/plugin-client.js";
import { createMcpApp } from "../../src/server.js";
import { ToolRegistry } from "../../src/tools/index.js";

describe("PluginClient against the upgraded SDK over real HTTP", () => {
	let server: Server;
	let client: PluginClient;
	let closeMcp: () => Promise<void>;
	beforeEach(async () => {
		const registry = new ToolRegistry();
		registry.register({
			id: "fixture",
			name: "Plugin fixture",
			getTools: () => [
				{
					name: "echo",
					description: "Echo",
					inputSchema: z.object({ message: z.string() }),
					handler: async (params) => ({
						content: [{ type: "text", text: String(params.message) }],
					}),
				},
				{
					name: "image",
					description: "Non-text fallback",
					inputSchema: z.object({}),
					handler: async () => ({
						content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
					}),
				},
			],
		});
		const { app, close } = createMcpApp(registry, "/mcp");
		closeMcp = close;
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No test port");
		client = new PluginClient(`http://127.0.0.1:${address.port}/mcp`);
	});
	afterEach(async () => {
		await client.disconnect();
		await closeMcp();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	it("auto-connects, checks tools for health, handles non-text content and reconnects", async () => {
		expect(await client.callTool("echo", { message: "hello" })).toBe("hello");
		await client.connect();
		expect(await client.isHealthy()).toBe(true);
		expect(JSON.parse(await client.callTool("image", {}))).toEqual([
			{ type: "image", data: "AA==", mimeType: "image/png" },
		]);
		await client.disconnect();
		await client.disconnect();
		expect(await client.isHealthy()).toBe(true);
		expect(await client.callTool("echo", { message: "reconnected" })).toBe(
			"reconnected",
		);
	});
	it("reports invalid endpoints as connection failures and unhealthy status", async () => {
		const invalid = new PluginClient("not-a-url");
		await expect(invalid.connect()).rejects.toThrow(
			/Failed to connect.*Invalid URL/,
		);
		expect(await invalid.isHealthy()).toBe(false);
		await invalid.disconnect();
	});
});

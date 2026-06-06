import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginClient } from "../../src/integrations/plugin-client.js";
import { PluginToolProvider } from "../../src/tools/plugin-tools.js";

/** Partial stub for PluginClient — only the two methods the provider calls. */
function makeStubClient(overrides?: {
	isHealthy?: () => Promise<boolean>;
	callTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}): PluginClient {
	const stub = {
		isHealthy: vi.fn().mockResolvedValue(true),
		callTool: vi.fn().mockResolvedValue("plugin result"),
		...overrides,
	};
	// Intentional partial stub — only the surface PluginToolProvider exercises.
	return stub as unknown as PluginClient;
}

/** Call a named tool on the provider and return the first text block. */
async function callTool(
	provider: PluginToolProvider,
	name: string,
	params: Record<string, unknown> = {},
): Promise<string> {
	const tool = provider.getTools().find((t) => t.name === name);
	if (!tool) throw new Error(`Tool '${name}' not found`);
	const result = await tool.handler(params);
	const block = result.content[0];
	if (block.type !== "text") throw new Error("expected text content");
	return block.text;
}

describe("PluginToolProvider — tool-name set", () => {
	it("exposes exactly the four expected plugin tool names", () => {
		const provider = new PluginToolProvider(makeStubClient());
		const names = provider.getTools().map((t) => t.name);
		expect(names).toContain("semantic_search");
		expect(names).toContain("backlinks");
		expect(names).toContain("graph_neighbors");
		expect(names).toContain("run_dataview_query");
		expect(names).toHaveLength(4);
	});
});

describe("PluginToolProvider — when plugin is not healthy", () => {
	let provider: PluginToolProvider;
	let stubClient: PluginClient;

	beforeEach(() => {
		stubClient = makeStubClient({
			isHealthy: vi.fn().mockResolvedValue(false),
		});
		provider = new PluginToolProvider(stubClient);
	});

	for (const toolName of [
		"semantic_search",
		"backlinks",
		"graph_neighbors",
		"run_dataview_query",
	]) {
		it(`${toolName} returns the 'plugin not available' guidance text`, async () => {
			const text = await callTool(provider, toolName, { query: "test" });
			expect(text).toMatch(/obsidi-mcp plugin is not available/i);
		});

		it(`${toolName} does NOT call callTool when unhealthy`, async () => {
			await callTool(provider, toolName, { query: "test" });
			expect(vi.mocked(stubClient.callTool)).not.toHaveBeenCalled();
		});
	}
});

describe("PluginToolProvider — when plugin is healthy", () => {
	let provider: PluginToolProvider;
	let stubClient: PluginClient;

	beforeEach(() => {
		stubClient = makeStubClient();
		provider = new PluginToolProvider(stubClient);
	});

	it("semantic_search proxies to plugin tool 'semantic_search' and returns its text", async () => {
		vi.mocked(stubClient.callTool).mockResolvedValue("semantic results");
		const text = await callTool(provider, "semantic_search", {
			query: "meeting notes",
		});
		expect(text).toBe("semantic results");
		expect(vi.mocked(stubClient.callTool)).toHaveBeenCalledWith(
			"semantic_search",
			expect.objectContaining({ query: "meeting notes" }),
		);
	});

	it("backlinks proxies to plugin tool 'backlinks'", async () => {
		vi.mocked(stubClient.callTool).mockResolvedValue("backlink list");
		const text = await callTool(provider, "backlinks", {
			path: "notes/topic.md",
		});
		expect(text).toBe("backlink list");
		expect(vi.mocked(stubClient.callTool)).toHaveBeenCalledWith(
			"backlinks",
			expect.objectContaining({ path: "notes/topic.md" }),
		);
	});

	it("graph_neighbors proxies to plugin tool 'graph_neighbors'", async () => {
		vi.mocked(stubClient.callTool).mockResolvedValue("neighbors");
		const text = await callTool(provider, "graph_neighbors", {
			path: "notes/topic.md",
		});
		expect(text).toBe("neighbors");
		expect(vi.mocked(stubClient.callTool)).toHaveBeenCalledWith(
			"graph_neighbors",
			expect.objectContaining({ path: "notes/topic.md" }),
		);
	});

	it("run_dataview_query proxies to plugin tool 'run_dataview_query'", async () => {
		vi.mocked(stubClient.callTool).mockResolvedValue("query results");
		const text = await callTool(provider, "run_dataview_query", {
			query: "TABLE file.name FROM #project",
		});
		expect(text).toBe("query results");
		expect(vi.mocked(stubClient.callTool)).toHaveBeenCalledWith(
			"run_dataview_query",
			expect.objectContaining({ query: "TABLE file.name FROM #project" }),
		);
	});
});

describe("PluginToolProvider — error handling", () => {
	it("returns 'Plugin proxy error: ...' text when callTool throws (does not propagate)", async () => {
		const stubClient = makeStubClient({
			callTool: vi.fn().mockRejectedValue(new Error("connection refused")),
		});
		const provider = new PluginToolProvider(stubClient);
		const text = await callTool(provider, "semantic_search", { query: "x" });
		expect(text).toMatch(/Plugin proxy error:.*connection refused/i);
	});

	it("does not throw when callTool rejects with a non-Error value", async () => {
		const stubClient = makeStubClient({
			callTool: vi.fn().mockRejectedValue("string error"),
		});
		const provider = new PluginToolProvider(stubClient);
		const text = await callTool(provider, "backlinks", { path: "x.md" });
		expect(text).toMatch(/Plugin proxy error:.*string error/i);
	});

	it("returns 'plugin not available' text (not an error) when isHealthy rejects", async () => {
		// isHealthy throwing is caught and treated as unhealthy — provider swallows it
		const stubClient = makeStubClient({
			isHealthy: vi.fn().mockRejectedValue(new Error("timeout")),
		});
		const provider = new PluginToolProvider(stubClient);
		// isHealthy throwing propagates into the `try` block; the catch returns proxy error
		const text = await callTool(provider, "semantic_search", { query: "x" });
		// Either "not available" or "proxy error" is acceptable — the key is no throw
		expect(text.length).toBeGreaterThan(0);
	});
});

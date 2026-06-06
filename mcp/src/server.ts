import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { logger } from "./logger.js";
import type { ToolRegistry } from "./tools/index.js";

/** JSON-RPC internal-error code (per the spec). */
const JSONRPC_INTERNAL_ERROR = -32603;

export function createMcpApp(registry: ToolRegistry, mcpPath: string) {
	const app = express();
	app.use(express.json());

	app.post(mcpPath, async (req: Request, res: Response) => {
		// The MCP SDK's stateless pattern binds one server to one transport per
		// request; both must be torn down when the response closes or they leak.
		const server = createServer(registry);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});

		res.on("close", () => {
			transport.close();
			server.close();
		});

		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("MCP request handling failed", { error: message });
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: {
						code: JSONRPC_INTERNAL_ERROR,
						message: "Internal server error",
					},
					id: null,
				});
			}
		}
	});

	// This server is stateless (no SSE stream / session resumption), so GET and
	// DELETE on the MCP endpoint are not supported.
	app.get(mcpPath, methodNotAllowed);
	app.delete(mcpPath, methodNotAllowed);

	return { app };
}

function methodNotAllowed(_req: Request, res: Response): void {
	res.status(405).json({
		jsonrpc: "2.0",
		error: { code: JSONRPC_INTERNAL_ERROR, message: "Method not allowed." },
		id: null,
	});
}

/** Summarize an input object as a sorted key list, truncated — never dump values. */
function describeInputKeys(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const keys = Object.keys(input as Record<string, unknown>).sort();
	if (keys.length === 0) return "";
	const shown = keys.slice(0, 10);
	const suffix = keys.length > shown.length ? ", …" : "";
	return ` (args: ${shown.join(", ")}${suffix})`;
}

function createServer(registry: ToolRegistry): McpServer {
	const server = new McpServer({
		name: "obaass-mcp",
		version: "0.1.0",
	});

	for (const tool of registry.getAllTools()) {
		server.tool(
			tool.name,
			tool.description,
			tool.inputSchema.shape,
			async (params) => {
				try {
					return await tool.handler(params as Record<string, unknown>);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					// Identify the failing tool and which args were supplied (keys only —
					// values may carry secrets) so agents get an actionable error.
					const keys = describeInputKeys(params);
					logger.error(`Tool '${tool.name}' failed`, {
						error: message,
						args: keys,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Error in '${tool.name}'${keys}: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}

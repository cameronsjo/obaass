import { toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import express, { type Request, type Response } from "express";
import { bearerAuthMiddleware } from "./auth.js";
import { httpSecurityMiddleware } from "./http-security.js";
import { logger } from "./logger.js";
import type { ToolRegistry } from "./tools/index.js";

/** JSON-RPC internal-error code (per the spec). */
const JSONRPC_INTERNAL_ERROR = -32603;

export interface McpAppOptions {
	/** Require `Authorization: Bearer <token>` on the MCP path (not /health). */
	authToken?: string | undefined;
	/** Serve only tools marked `readOnly`. */
	readOnly?: boolean;
}

export function createMcpApp(
	registry: ToolRegistry,
	mcpPath: string,
	options: McpAppOptions = {},
) {
	const app = express();
	app.use(httpSecurityMiddleware());
	// Before body parsing so an unauthenticated request never reaches the parser.
	if (options.authToken) {
		app.use(mcpPath, bearerAuthMiddleware(options.authToken));
	}
	app.use(express.json());
	const onerror = (error: Error) => {
		logger.error("MCP request handling failed", { error: error.message });
	};
	// Fresh server per request for both 2026-07-28 and older stateless clients.
	const handler = createMcpHandler(
		() => createServer(registry, !!options.readOnly),
		{
			legacy: "stateless",
			// This app publishes no events; do not retain idle subscription streams.
			maxSubscriptions: 0,
			onerror,
		},
	);
	const nodeHandler = toNodeHandler(handler, { onerror });
	// Keep express.json's existing body limit and pass its consumed body explicitly.
	app.post(mcpPath, (req: Request, res: Response) =>
		nodeHandler(req, res, req.body),
	);

	// GET-based SSE and session resumption remain unsupported; modern exchanges
	// and legacy stateless requests are served through POST.
	app.get(mcpPath, methodNotAllowed);
	app.delete(mcpPath, methodNotAllowed);

	return { app, close: handler.close };
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

function createServer(registry: ToolRegistry, readOnly: boolean): McpServer {
	const server = new McpServer({
		name: "obaass-mcp",
		version: "0.1.0",
	});

	for (const tool of registry.getServedTools(readOnly)) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
				...(tool.outputSchema && { outputSchema: tool.outputSchema }),
			},
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

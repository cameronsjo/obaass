import { randomUUID } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
	type AuthInfo,
	type McpRequestContext,
	McpServer,
	createMcpHandler,
} from "@modelcontextprotocol/server";
import express, { type Request, type Response } from "express";
import { bearerAuthMiddleware } from "./auth.js";
import { httpSecurityMiddleware } from "./http-security.js";
import { logger } from "./logger.js";
import type { ToolRegistry } from "./tools/index.js";
import {
	type Access,
	type AccessOptions,
	RefusalLog,
	type TierTokens,
	hasTokens,
	resolveAccess,
	toolAllowed,
} from "./tools/tiers.js";
import { AccessRefusal } from "./vault/vault-service.js";

/** JSON-RPC internal-error code (per the spec). */
const JSONRPC_INTERNAL_ERROR = -32603;
/** JSON-RPC implementation-defined server error, used for the rate limit. */
const JSONRPC_RATE_LIMITED = -32000;

/** Server-assigned per-request id; any client-supplied value is replaced. */
const REQUEST_ID_HEADER = "x-obaass-request-id";
/** Shape a gateway-supplied correlation id must have to be recorded. */
const UPSTREAM_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Requests per minute allowed to each non-`full` access level, across all its clients. */
export const RESTRICTED_REQUESTS_PER_MINUTE = 120;
const RATE_WINDOW_MS = 60_000;

export interface McpAppOptions {
	/** Configured bearer tokens. With any set, every MCP request needs one. */
	tokens?: TierTokens;
	/** MCP_ALLOW_UNAUTHENTICATED with no token: serve the anonymous read set. */
	anonymous?: boolean;
	/** Header a gateway may send with its own request id (correlation only). */
	upstreamRequestIdHeader?: string;
}

const KNOWN_APP_OPTIONS: ReadonlySet<string> = new Set([
	"tokens",
	"anonymous",
	"upstreamRequestIdHeader",
]);

interface CallIds {
	requestId: string;
	upstreamRequestId?: string;
}

/** Fixed-window request counter per access level. */
class RateLimiter {
	private windows = new Map<Access, { start: number; count: number }>();

	constructor(private readonly now: () => number = Date.now) {}

	/** Counts `messages` JSON-RPC messages, so one batch POST cannot carry 100 calls as one. */
	allow(access: Access, messages: number): boolean {
		const now = this.now();
		let window = this.windows.get(access);
		if (!window || now - window.start >= RATE_WINDOW_MS) {
			window = { start: now, count: 0 };
			this.windows.set(access, window);
		}
		window.count += messages;
		return window.count <= RESTRICTED_REQUESTS_PER_MINUTE;
	}
}

function callIds(
	headers: Headers | undefined,
	upstreamHeader: string | undefined,
): CallIds {
	const requestId = headers?.get(REQUEST_ID_HEADER) ?? "unassigned";
	const upstream = upstreamHeader ? headers?.get(upstreamHeader) : undefined;
	return upstream && UPSTREAM_REQUEST_ID.test(upstream)
		? { requestId, upstreamRequestId: upstream }
		: { requestId };
}

/** Out-of-tier `tools/call` names in a parsed JSON-RPC body (single or batch). */
function outOfTierCalls(body: unknown, access: Access | undefined): string[] {
	const messages = Array.isArray(body) ? body : [body];
	return messages.flatMap((message) => {
		const m = message as { method?: unknown; params?: { name?: unknown } };
		const name = m?.method === "tools/call" ? m.params?.name : undefined;
		return typeof name === "string" && !toolAllowed(access, name) ? [name] : [];
	});
}

export function createMcpApp(
	registry: ToolRegistry,
	mcpPath: string,
	options: McpAppOptions = {},
) {
	// An unrecognized key (such as the retired `authToken`) would otherwise be
	// ignored and leave the endpoint without authentication.
	const unknownKeys = Object.keys(options).filter(
		(key) => !KNOWN_APP_OPTIONS.has(key),
	);
	if (unknownKeys.length > 0) {
		throw new Error(
			`createMcpApp: unknown option(s) ${unknownKeys.join(", ")}; expected ${[...KNOWN_APP_OPTIONS].join(", ")}`,
		);
	}
	const accessOptions: AccessOptions = {
		tokens: options.tokens ?? {},
		anonymous: options.anonymous,
	};
	const refusals = new RefusalLog(registry.getToolNames());
	const flushTimer = setInterval(() => refusals.flush(), RATE_WINDOW_MS);
	flushTimer.unref();
	const limiter = new RateLimiter();

	const app = express();
	app.use(httpSecurityMiddleware());
	app.use(mcpPath, (req, _res, next) => {
		req.headers[REQUEST_ID_HEADER] = randomUUID();
		next();
	});
	// Before body parsing so an unauthenticated request never reaches the parser.
	if (hasTokens(accessOptions.tokens)) {
		app.use(mcpPath, bearerAuthMiddleware(accessOptions.tokens));
	}
	app.use(express.json());
	const onerror = (error: Error) => {
		logger.error("MCP request handling failed", { error: error.message });
	};
	// Fresh server per request for both 2026-07-28 and older stateless clients.
	const handler = createMcpHandler(
		(ctx: McpRequestContext) =>
			createServer(
				registry,
				resolveAccess(accessOptions, ctx.authInfo),
				callIds(ctx.requestInfo?.headers, options.upstreamRequestIdHeader),
				refusals,
			),
		{
			legacy: "stateless",
			// This app publishes no events; do not retain idle subscription streams.
			maxSubscriptions: 0,
			onerror,
		},
	);
	const nodeHandler = toNodeHandler(handler, { onerror });
	// Keep express.json's existing body limit and pass its consumed body explicitly.
	app.post(mcpPath, (req: Request, res: Response) => {
		const auth = (req as Request & { auth?: AuthInfo }).auth;
		const access = resolveAccess(accessOptions, auth);
		const requestId = String(req.headers[REQUEST_ID_HEADER]);
		const messages = Array.isArray(req.body) ? Math.max(req.body.length, 1) : 1;
		if (access && access !== "full" && !limiter.allow(access, messages)) {
			refusals.record(access, undefined, "rate_limited", requestId);
			res.status(429).json({
				jsonrpc: "2.0",
				error: {
					code: JSONRPC_RATE_LIMITED,
					message: `Rate limit exceeded for this access tier (${RESTRICTED_REQUESTS_PER_MINUTE} messages per minute, batches counted per message); retry later.`,
				},
				id: null,
			});
			return;
		}
		// The SDK refuses an unregistered tool with no callback, so the audit
		// line for an out-of-tier call is taken from the parsed body here.
		for (const name of outOfTierCalls(req.body, access)) {
			refusals.record(access ?? "none", name, "out_of_tier", requestId);
		}
		return nodeHandler(req, res, req.body);
	});

	// GET-based SSE and session resumption remain unsupported; modern exchanges
	// and legacy stateless requests are served through POST.
	app.get(mcpPath, methodNotAllowed);
	app.delete(mcpPath, methodNotAllowed);

	const close = async () => {
		clearInterval(flushTimer);
		refusals.flush();
		await handler.close();
	};
	return { app, close };
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

function errorResult(toolName: string, keys: string, message: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: `Error in '${toolName}'${keys}: ${message}`,
			},
		],
		isError: true,
	};
}

function createServer(
	registry: ToolRegistry,
	access: Access | undefined,
	ids: CallIds,
	refusals: RefusalLog,
): McpServer {
	const server = new McpServer({
		name: "obaass-mcp",
		version: "0.1.0",
	});
	// No valid access (auth configured, tier missing or unknown): register nothing.
	if (!access) return server;

	for (const tool of registry.getServedTools(access)) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
				...(tool.outputSchema && { outputSchema: tool.outputSchema }),
				annotations: { readOnlyHint: tool.readOnly === true },
			},
			async (params) => {
				// Keys only, never values: they may carry secrets or note content.
				const keys = describeInputKeys(params);
				const fields = { tool: tool.name, tier: access, ...ids, args: keys };
				if (tool.readOnly) logger.debug("Dispatching read tool", fields);
				else logger.info("Dispatching write tool", fields);
				try {
					return await tool.handler(params as Record<string, unknown>, {
						access,
					});
				} catch (err) {
					if (err instanceof AccessRefusal) {
						// Refusal messages carry no path; the audit line carries the kind.
						refusals.record(access, tool.name, err.kind, ids.requestId);
						return errorResult(tool.name, keys, err.message);
					}
					const message = err instanceof Error ? err.message : String(err);
					logger.error(`Tool '${tool.name}' failed`, {
						...fields,
						error: message,
					});
					return errorResult(tool.name, keys, message);
				}
			},
		);
	}

	return server;
}

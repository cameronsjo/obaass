import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";
import { logger } from "./logger.js";

/** Shortest accepted MCP_AUTH_TOKEN; `openssl rand -hex 32` gives 64. */
export const MIN_AUTH_TOKEN_LENGTH = 32;

/** At most one rejection log line per window, so a scanner cannot flood logs. */
const REJECTION_LOG_WINDOW_MS = 60_000;

export interface AccessPolicyInput {
	httpHost: string;
	authToken?: string | undefined;
	allowUnauthenticated: boolean;
	/** MCP_ALLOWED_HOSTS is set: a proxy or remote name is expected to reach the bind. */
	hasAllowedHosts: boolean;
}

export interface AccessPolicy {
	/** When true, only tools marked `readOnly` are registered. */
	readOnly: boolean;
	/** Startup warning to log, if the policy is weaker than recommended. */
	warning: string | undefined;
}

/**
 * True only for loopback IP literals. Names such as `localhost` are refused
 * because `listen()` binds whatever the resolver returns for them.
 */
export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[(.*)\]$/, "$1");
	if (isIP(bare) === 4) return bare.startsWith("127.");
	if (isIP(bare) === 6) return bare === "::1";
	return false;
}

/**
 * Decide how the MCP endpoint is protected. Write tools are never reachable
 * off loopback without a token: an unauthenticated non-loopback bind refuses to
 * start, and the explicit opt-out drops to read-only tools.
 */
export function resolveAccessPolicy(input: AccessPolicyInput): AccessPolicy {
	if (input.authToken) return { readOnly: false, warning: undefined };
	if (isLoopbackHost(input.httpHost) && !input.hasAllowedHosts) {
		return { readOnly: false, warning: undefined };
	}
	const reach = input.hasAllowedHosts
		? "MCP_ALLOWED_HOSTS admits non-loopback clients"
		: `MCP_HTTP_HOST=${input.httpHost} is not a loopback IP`;
	if (!input.allowUnauthenticated) {
		throw new Error(
			[
				`${reach}, but MCP_AUTH_TOKEN is not set.`,
				`Set MCP_AUTH_TOKEN (at least ${MIN_AUTH_TOKEN_LENGTH} characters, e.g. \`openssl rand -hex 32\`),`,
				"bind MCP_HTTP_HOST=127.0.0.1, or set MCP_ALLOW_UNAUTHENTICATED=true to serve read-only tools without a token.",
			].join(" "),
		);
	}
	return {
		readOnly: true,
		warning: `MCP_ALLOW_UNAUTHENTICATED=true (${reach}): serving read-only tools without authentication. Write tools are disabled until MCP_AUTH_TOKEN is set.`,
	};
}

/** Constant-time comparison; hashing first removes the length side channel. */
export function tokensMatch(presented: string, expected: string): boolean {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/** True when the request carries `Authorization: Bearer <token>`. */
export function hasValidBearer(req: Request, token: string): boolean {
	const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(req.headers.authorization ?? "");
	return !!match?.[1] && tokensMatch(match[1], token);
}

/** Require `Authorization: Bearer <token>` before parsing or dispatch. */
export function bearerAuthMiddleware(
	token: string,
	now: () => number = Date.now,
): RequestHandler {
	let windowStart = Number.NEGATIVE_INFINITY;
	let suppressed = 0;
	return (req, res, next) => {
		if (hasValidBearer(req, token)) return next();
		if (now() - windowStart >= REJECTION_LOG_WINDOW_MS) {
			logger.warn("Rejected MCP request without a valid bearer token", {
				remoteAddress: req.socket.remoteAddress,
				credentialPresent: !!req.headers.authorization,
				suppressedSinceLastLog: suppressed,
			});
			windowStart = now();
			suppressed = 0;
		} else {
			suppressed++;
		}
		res
			.status(401)
			.set("WWW-Authenticate", 'Bearer realm="obaass-mcp"')
			.json({
				jsonrpc: "2.0",
				error: {
					code: -32001,
					message: "Unauthorized: a valid bearer token is required.",
				},
				id: null,
			});
	};
}

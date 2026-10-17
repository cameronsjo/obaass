import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { RequestHandler } from "express";
import { logger } from "./logger.js";

/** Shortest accepted MCP_AUTH_TOKEN; `openssl rand -hex 32` gives 64. */
export const MIN_AUTH_TOKEN_LENGTH = 32;

export interface AccessPolicyInput {
	httpHost: string;
	authToken?: string | undefined;
	allowUnauthenticated: boolean;
}

export interface AccessPolicy {
	/** When set, every request on the MCP path must carry this bearer token. */
	authToken: string | undefined;
	/** When true, only tools marked `readOnly` are registered. */
	readOnly: boolean;
	/** Startup warning to log, if the policy is weaker than recommended. */
	warning: string | undefined;
}

/** True only for binds that no other host can reach. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	if (bare === "localhost") return true;
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
	if (input.authToken) {
		return { authToken: input.authToken, readOnly: false, warning: undefined };
	}
	if (isLoopbackHost(input.httpHost)) {
		return { authToken: undefined, readOnly: false, warning: undefined };
	}
	if (!input.allowUnauthenticated) {
		throw new Error(
			[
				`MCP_HTTP_HOST=${input.httpHost} is reachable beyond loopback, but MCP_AUTH_TOKEN is not set.`,
				`Set MCP_AUTH_TOKEN (at least ${MIN_AUTH_TOKEN_LENGTH} characters, e.g. \`openssl rand -hex 32\`),`,
				"bind MCP_HTTP_HOST=127.0.0.1, or set MCP_ALLOW_UNAUTHENTICATED=true to serve read-only tools without a token.",
			].join(" "),
		);
	}
	return {
		authToken: undefined,
		readOnly: true,
		warning: `MCP_ALLOW_UNAUTHENTICATED=true: serving read-only tools without authentication on ${input.httpHost}. Write tools are disabled until MCP_AUTH_TOKEN is set.`,
	};
}

/** Constant-time comparison; hashing first removes the length side channel. */
export function tokensMatch(presented: string, expected: string): boolean {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/** Require `Authorization: Bearer <token>` before parsing or dispatch. */
export function bearerAuthMiddleware(token: string): RequestHandler {
	return (req, res, next) => {
		const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(
			req.headers.authorization ?? "",
		);
		if (match?.[1] && tokensMatch(match[1], token)) return next();
		logger.warn("Rejected MCP request without a valid bearer token", {
			remoteAddress: req.socket.remoteAddress,
			credentialPresent: !!req.headers.authorization,
		});
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

import {
	hostHeaderValidation,
	originValidation,
} from "@modelcontextprotocol/node";
import { localhostAllowedHostnames } from "@modelcontextprotocol/server";
import type { RequestHandler, Response } from "express";

type Endpoint = {
	hostname: string;
	protocol: "http:" | "https:";
	port?: number;
};

/** One explicit allowlist controls both Host authorities and browser origins. */
export function httpSecurityMiddleware(
	configuredPort?: number,
): RequestHandler {
	const defaults: Endpoint[] = localhostAllowedHostnames().map((hostname) => ({
		hostname,
		protocol: "http:",
	}));
	const additional = (process.env.MCP_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			try {
				return parseEndpoint(entry, true);
			} catch {
				throw new Error(
					"MCP_ALLOWED_HOSTS must contain hostnames, host:port entries, or HTTP(S) origins; wildcards and paths are not allowed.",
				);
			}
		});
	const endpoints = [...defaults, ...additional];
	const hostnames = [
		...new Set(endpoints.map((endpoint) => endpoint.hostname)),
	];
	const validateHost = hostHeaderValidation(hostnames);
	const validateOrigin = originValidation(hostnames);

	return (req, res, next) => {
		// These SDK guards answer 403 themselves. Always run before body parsing,
		// session routing or any tool dispatch; forwarded headers are not trusted.
		if (!validateHost(req, res) || !validateOrigin(req, res)) return;
		const serverPort = configuredPort || req.socket.localPort;
		if (!serverPort) return forbidden(res, "Server port unavailable.");
		const authorities = new Set<string>();
		const origins = new Set<string>();
		for (const endpoint of endpoints) {
			const port = endpoint.port ?? serverPort;
			authorities.add(`${endpoint.hostname}:${port}`);
			if (
				(endpoint.protocol === "http:" && port === 80) ||
				(endpoint.protocol === "https:" && port === 443)
			) {
				authorities.add(`${endpoint.hostname}:`);
			}
			origins.add(
				new URL(`${endpoint.protocol}//${endpoint.hostname}:${port}`).origin,
			);
		}
		try {
			const host = parseEndpoint(req.headers.host ?? "", false);
			if (!authorities.has(`${host.hostname}:${host.port ?? ""}`)) {
				return forbidden(res, "Invalid Host authority: port is not allowed.");
			}
		} catch {
			return forbidden(res, "Invalid Host authority.");
		}
		const origin = req.headers.origin;
		if (origin) {
			try {
				// Origin is a serialized origin, not a URL with credentials or a path.
				if (!/^https?:\/\/[^\s\\/?#@]+$/i.test(origin))
					throw new Error("Invalid origin");
				if (!origins.has(new URL(origin).origin)) {
					return forbidden(
						res,
						"Invalid Origin: scheme or port is not allowed.",
					);
				}
			} catch {
				return forbidden(res, "Invalid Origin.");
			}
		}
		next();
	};
}

function parseEndpoint(value: string, allowOrigin: boolean): Endpoint {
	const hasScheme = /^https?:\/\//i.test(value);
	if (hasScheme && !allowOrigin)
		throw new Error("Host must not include a scheme");
	const authority = hasScheme
		? value.replace(/^https?:\/\//i, "").replace(/\/$/, "")
		: value;
	if (!authority || /[\s\\/?#@*]/.test(authority) || authority.endsWith(":")) {
		throw new Error("Invalid authority");
	}
	const url = new URL(hasScheme ? value : `http://${authority}`);
	const explicitPort = authority.match(/:(\d+)$/)?.[1];
	const port = explicitPort
		? Number(explicitPort)
		: hasScheme
			? url.protocol === "https:"
				? 443
				: 80
			: undefined;
	if (port !== undefined && (port < 1 || port > 65535)) {
		throw new Error("Invalid port");
	}
	return {
		hostname: url.hostname,
		protocol: url.protocol as Endpoint["protocol"],
		port,
	};
}

function forbidden(res: Response, message: string): void {
	res
		.status(403)
		.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

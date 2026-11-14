import { statSync } from "node:fs";
import { z } from "zod";
import {
	MIN_AUTH_TOKEN_LENGTH,
	resolveAccessPolicy,
	tokensMatch,
} from "./auth.js";
import type { TierTokens } from "./tools/tiers.js";

/**
 * MCP_LIMITED_WRITE_DIRS: comma-separated vault-relative folders the limited
 * tier may write under. Unset or empty means no folder restriction.
 */
function parseWriteDirs(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const dirs = value
		.split(",")
		.map((d) => d.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
		.filter((d) => d !== "");
	for (const dir of dirs) {
		const segments = dir.split("/");
		if (
			dir.startsWith("/") ||
			segments.some((s) => s === "" || s === ".." || s.startsWith("."))
		) {
			throw new Error(
				`MCP_LIMITED_WRITE_DIRS entries must be vault-relative folders without "..", empty, or dot segments; got an invalid entry of ${dir.length} characters`,
			);
		}
	}
	return dirs.length > 0 ? dirs : undefined;
}

function tokenSchema(variable: string) {
	return z
		.string()
		.min(
			MIN_AUTH_TOKEN_LENGTH,
			`${variable} must be at least ${MIN_AUTH_TOKEN_LENGTH} characters (generate one with \`openssl rand -hex 32\`)`,
		)
		.regex(/^\S+$/, `${variable} must not contain whitespace`)
		.optional();
}

const configSchema = z.object({
	vaultPath: z.string().min(1, "VAULT_PATH is required"),
	httpPort: z.coerce.number().int().positive().default(3000),
	httpHost: z.string().default("127.0.0.1"),
	httpPath: z
		.string()
		// Literal segments only: Express would compile `:x` or `*` as a pattern.
		.regex(
			/^(\/[A-Za-z0-9._~-]+)+$/,
			"MCP_HTTP_PATH must be a literal path below / such as /mcp",
		)
		.refine((path) => !/^\/health(\/|$)/i.test(path), {
			message: "MCP_HTTP_PATH must not be under /health",
		})
		.default("/mcp"),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	backupUrl: z.string().url().optional(),
	pluginMcpUrl: z.string().url().optional(),
	dailyNoteFolder: z.string().optional(),
	dailyNoteTemplate: z.string().optional(),
	limitedWriteDirs: z
		.string()
		.optional()
		.transform((value) => parseWriteDirs(value)),
	authToken: tokenSchema("MCP_AUTH_TOKEN"),
	limitedAuthToken: tokenSchema("MCP_AUTH_TOKEN_LIMITED"),
	upstreamRequestIdHeader: z
		.string()
		.regex(
			/^[A-Za-z0-9-]{1,64}$/,
			"MCP_UPSTREAM_REQUEST_ID_HEADER must be an HTTP header name",
		)
		.default("x-request-id")
		.transform((name) => name.toLowerCase()),
	allowUnauthenticated: z
		.enum(["true", "false"], {
			error: 'MCP_ALLOW_UNAUTHENTICATED must be "true" or "false"',
		})
		.default("false")
		.transform((value) => value === "true"),
});

export type Config = z.infer<typeof configSchema> & {
	/** No token is configured and the unauthenticated opt-out is on: serve the anonymous set. */
	anonymous: boolean;
	/** Startup warning for a weaker-than-recommended access policy. */
	accessWarning: string | undefined;
};

export function loadConfig(): Config {
	const parsed = configSchema.parse({
		vaultPath: process.env.VAULT_PATH,
		httpPort: process.env.MCP_HTTP_PORT,
		httpHost: process.env.MCP_HTTP_HOST,
		httpPath: process.env.MCP_HTTP_PATH,
		logLevel: process.env.LOG_LEVEL,
		backupUrl: process.env.BACKUP_URL || undefined,
		pluginMcpUrl: process.env.PLUGIN_MCP_URL || undefined,
		dailyNoteFolder: process.env.DAILY_NOTE_FOLDER || undefined,
		dailyNoteTemplate: process.env.DAILY_NOTE_TEMPLATE || undefined,
		limitedWriteDirs: process.env.MCP_LIMITED_WRITE_DIRS || undefined,
		authToken: process.env.MCP_AUTH_TOKEN || undefined,
		limitedAuthToken: process.env.MCP_AUTH_TOKEN_LIMITED || undefined,
		upstreamRequestIdHeader:
			process.env.MCP_UPSTREAM_REQUEST_ID_HEADER || undefined,
		allowUnauthenticated: process.env.MCP_ALLOW_UNAUTHENTICATED || undefined,
	});

	// Fail fast with a clear message if the vault path is unusable — far better
	// than every tool call failing later with an opaque ENOENT.
	assertVaultPathUsable(parsed.vaultPath);

	if (
		parsed.authToken &&
		parsed.limitedAuthToken &&
		tokensMatch(parsed.authToken, parsed.limitedAuthToken)
	) {
		throw new Error(
			"MCP_AUTH_TOKEN_LIMITED must differ from MCP_AUTH_TOKEN. Generate a separate value for each with `openssl rand -hex 32`.",
		);
	}

	// Refuses to start when tools beyond the anonymous read set would be reachable
	// off loopback without a token.
	const access = resolveAccessPolicy({
		...parsed,
		hasAllowedHosts: !!process.env.MCP_ALLOWED_HOSTS?.trim(),
	});
	return {
		...parsed,
		anonymous: access.anonymous,
		accessWarning: access.warning,
	};
}

function assertVaultPathUsable(vaultPath: string): void {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(vaultPath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`VAULT_PATH does not exist: ${vaultPath}`);
		}
		throw new Error(
			`VAULT_PATH is not accessible: ${vaultPath} (${err instanceof Error ? err.message : String(err)})`,
		);
	}
	if (!stats.isDirectory()) {
		throw new Error(`VAULT_PATH is not a directory: ${vaultPath}`);
	}
}

/** The token table the bearer middleware and health check read. */
export function configuredTokens(config: Config): TierTokens {
	return { full: config.authToken, limited: config.limitedAuthToken };
}

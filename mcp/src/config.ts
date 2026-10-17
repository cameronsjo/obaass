import { statSync } from "node:fs";
import { z } from "zod";
import { MIN_AUTH_TOKEN_LENGTH, resolveAccessPolicy } from "./auth.js";

const configSchema = z.object({
	vaultPath: z.string().min(1, "VAULT_PATH is required"),
	httpPort: z.coerce.number().int().positive().default(3000),
	httpHost: z.string().default("127.0.0.1"),
	httpPath: z
		.string()
		.regex(/^\/[^\s?#]+$/, "MCP_HTTP_PATH must be a path below / such as /mcp")
		.refine((path) => path.toLowerCase() !== "/health", {
			message: "MCP_HTTP_PATH must not be /health",
		})
		.default("/mcp"),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	backupUrl: z.string().url().optional(),
	pluginMcpUrl: z.string().url().optional(),
	dailyNoteFolder: z.string().optional(),
	dailyNoteTemplate: z.string().optional(),
	authToken: z
		.string()
		.min(
			MIN_AUTH_TOKEN_LENGTH,
			`MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`,
		)
		.regex(/^\S+$/, "MCP_AUTH_TOKEN must not contain whitespace")
		.optional(),
	allowUnauthenticated: z
		.enum(["true", "false"], {
			error: 'MCP_ALLOW_UNAUTHENTICATED must be "true" or "false"',
		})
		.default("false")
		.transform((value) => value === "true"),
});

export type Config = z.infer<typeof configSchema> & {
	/** Only tools marked `readOnly` are served (unauthenticated opt-out). */
	readOnly: boolean;
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
		authToken: process.env.MCP_AUTH_TOKEN || undefined,
		allowUnauthenticated: process.env.MCP_ALLOW_UNAUTHENTICATED || undefined,
	});

	// Fail fast with a clear message if the vault path is unusable — far better
	// than every tool call failing later with an opaque ENOENT.
	assertVaultPathUsable(parsed.vaultPath);

	// Refuses to start when write tools would be reachable off loopback unauthenticated.
	const access = resolveAccessPolicy({
		...parsed,
		hasAllowedHosts: !!process.env.MCP_ALLOWED_HOSTS?.trim(),
	});
	return {
		...parsed,
		readOnly: access.readOnly,
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

import { statSync } from "node:fs";
import { z } from "zod";

const configSchema = z.object({
	vaultPath: z.string().min(1, "VAULT_PATH is required"),
	httpPort: z.coerce.number().int().positive().default(3000),
	httpHost: z.string().default("0.0.0.0"),
	httpPath: z.string().default("/mcp"),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	backupUrl: z.string().url().optional(),
	pluginMcpUrl: z.string().url().optional(),
	dailyNoteFolder: z.string().optional(),
	dailyNoteTemplate: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
	const config = configSchema.parse({
		vaultPath: process.env.VAULT_PATH,
		httpPort: process.env.MCP_HTTP_PORT,
		httpHost: process.env.MCP_HTTP_HOST,
		httpPath: process.env.MCP_HTTP_PATH,
		logLevel: process.env.LOG_LEVEL,
		backupUrl: process.env.BACKUP_URL || undefined,
		pluginMcpUrl: process.env.PLUGIN_MCP_URL || undefined,
		dailyNoteFolder: process.env.DAILY_NOTE_FOLDER || undefined,
		dailyNoteTemplate: process.env.DAILY_NOTE_TEMPLATE || undefined,
	});

	// Fail fast with a clear message if the vault path is unusable — far better
	// than every tool call failing later with an opaque ENOENT.
	assertVaultPathUsable(config.vaultPath);

	return config;
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

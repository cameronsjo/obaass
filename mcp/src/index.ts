import { ZodError } from "zod";
import { configuredTokens, loadConfig } from "./config.js";
import { createHealthHandler } from "./health.js";
import { BackupClient } from "./integrations/backup-client.js";
import { PluginClient } from "./integrations/plugin-client.js";
import { logger, setLogLevel } from "./logger.js";
import { createMcpApp } from "./server.js";
import { installShutdownHandlers } from "./shutdown.js";
import { BackupToolProvider } from "./tools/backup-tools.js";
import { ToolRegistry } from "./tools/index.js";
import { PluginToolProvider } from "./tools/plugin-tools.js";
import { tokenFingerprints } from "./tools/tiers.js";
import { VaultToolProvider } from "./tools/vault-tools.js";
import { VaultService } from "./vault/vault-service.js";

async function main() {
	const config = loadConfig();
	setLogLevel(config.logLevel);
	const tokens = configuredTokens(config);
	const fingerprints = tokenFingerprints(tokens);

	logger.info("Starting obaass-mcp", {
		vaultPath: config.vaultPath,
		port: config.httpPort,
		backupEnabled: !!config.backupUrl,
		pluginEnabled: !!config.pluginMcpUrl,
		host: config.httpHost,
		tiers: fingerprints.map((f) => f.tier),
		tokenFingerprints: fingerprints,
		anonymous: config.anonymous,
		limitedWriteDirs: config.limitedWriteDirs ?? "vault-wide",
	});
	if (config.accessWarning) logger.warn(config.accessWarning);

	// Core services
	const vault = new VaultService(config.vaultPath);
	const registry = new ToolRegistry();

	// Always register core vault tools
	registry.register(new VaultToolProvider(vault, config));

	// Optional: backup integration
	let backupClient: BackupClient | undefined;
	if (config.backupUrl) {
		backupClient = new BackupClient(config.backupUrl);
		registry.register(new BackupToolProvider(backupClient, config.vaultPath));
		logger.info("Backup integration enabled", { url: config.backupUrl });
	}

	// Optional: plugin integration
	let pluginClient: PluginClient | undefined;
	if (config.pluginMcpUrl) {
		pluginClient = new PluginClient(config.pluginMcpUrl);
		registry.register(new PluginToolProvider(pluginClient));
		logger.info("Plugin integration enabled", { url: config.pluginMcpUrl });
	}

	// Create MCP app
	const { app, close } = createMcpApp(registry, config.httpPath, {
		tokens,
		anonymous: config.anonymous,
		upstreamRequestIdHeader: config.upstreamRequestIdHeader,
	});

	// Health endpoint
	const startTime = Date.now();
	app.get(
		"/health",
		createHealthHandler({
			config,
			vault,
			backupClient,
			pluginClient,
			startTime,
		}),
	);

	// Start server
	const httpServer = app.listen(config.httpPort, config.httpHost, () => {
		logger.info("obaass-mcp ready", {
			address: `http://${config.httpHost}:${config.httpPort}`,
			mcpPath: config.httpPath,
			toolCount: registry.getAllTools().length,
			providers: registry.getProviderIds(),
		});
	});

	installShutdownHandlers(httpServer, pluginClient, close);
}

/** Config errors as `field: reason` lines; the messages name the env variable. */
function describeStartupError(err: unknown): string {
	if (err instanceof ZodError) {
		return err.issues
			.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
			.join("; ");
	}
	return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
	logger.error("Fatal startup error", { error: describeStartupError(err) });
	process.exit(1);
});

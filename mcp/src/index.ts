import { loadConfig } from "./config.js";
import { createHealthHandler } from "./health.js";
import { BackupClient } from "./integrations/backup-client.js";
import { PluginClient } from "./integrations/plugin-client.js";
import { logger, setLogLevel } from "./logger.js";
import { createMcpApp } from "./server.js";
import { BackupToolProvider } from "./tools/backup-tools.js";
import { ToolRegistry } from "./tools/index.js";
import { PluginToolProvider } from "./tools/plugin-tools.js";
import { VaultToolProvider } from "./tools/vault-tools.js";
import { VaultService } from "./vault/vault-service.js";

async function main() {
	const config = loadConfig();
	setLogLevel(config.logLevel);

	logger.info("Starting obaass-mcp", {
		vaultPath: config.vaultPath,
		port: config.httpPort,
		backupEnabled: !!config.backupUrl,
		pluginEnabled: !!config.pluginMcpUrl,
	});

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
	const { app } = createMcpApp(registry, config.httpPath);

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
		const tools = registry.getAllTools();
		logger.info("obaass-mcp ready", {
			address: `http://${config.httpHost}:${config.httpPort}`,
			mcpPath: config.httpPath,
			toolCount: tools.length,
			providers: registry.getProviderIds(),
		});
	});

	installShutdownHandlers(httpServer, pluginClient);
}

/**
 * Wire SIGTERM/SIGINT to a graceful shutdown: stop accepting connections, close
 * the plugin client, and force-exit if cleanup stalls. Also trap otherwise-fatal
 * async errors so a single rejection cannot silently take down the process.
 */
function installShutdownHandlers(
	httpServer: import("node:http").Server,
	pluginClient: PluginClient | undefined,
): void {
	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down", { signal });

		// Hard cap so a hung connection can't block exit forever.
		const forceExit = setTimeout(() => {
			logger.warn("Forced exit after shutdown timeout");
			process.exit(1);
		}, 10_000);
		forceExit.unref();

		httpServer.close(async () => {
			try {
				await pluginClient?.disconnect();
			} catch (err) {
				logger.warn("Error during plugin disconnect", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			logger.info("Shutdown complete");
			process.exit(0);
		});
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	process.on("unhandledRejection", (reason) => {
		logger.error("Unhandled promise rejection", {
			error: reason instanceof Error ? reason.message : String(reason),
		});
	});
	process.on("uncaughtException", (err) => {
		logger.error("Uncaught exception", {
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

main().catch((err) => {
	logger.error("Fatal startup error", {
		error: err instanceof Error ? err.message : String(err),
	});
	process.exit(1);
});

import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./logger.js";
import { VaultService } from "./vault/vault-service.js";
import { ToolRegistry } from "./tools/index.js";
import { VaultToolProvider } from "./tools/vault-tools.js";
import { BackupToolProvider } from "./tools/backup-tools.js";
import { PluginToolProvider } from "./tools/plugin-tools.js";
import { BackupClient } from "./integrations/backup-client.js";
import { PluginClient } from "./integrations/plugin-client.js";
import { createMcpApp } from "./server.js";
import { createHealthHandler } from "./health.js";

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
  app.get("/health", createHealthHandler({
    config,
    vault,
    backupClient,
    pluginClient,
    startTime,
  }));

  // Start server
  app.listen(config.httpPort, config.httpHost, () => {
    const tools = registry.getAllTools();
    logger.info("obaass-mcp ready", {
      address: `http://${config.httpHost}:${config.httpPort}`,
      mcpPath: config.httpPath,
      toolCount: tools.length,
      providers: registry.getProviderIds(),
    });
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

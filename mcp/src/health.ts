import type { Request, Response } from "express";
import type { Config } from "./config.js";
import type { BackupClient } from "./integrations/backup-client.js";
import type { PluginClient } from "./integrations/plugin-client.js";
import type { VaultService } from "./vault/vault-service.js";

export interface HealthDeps {
	config: Config;
	vault: VaultService;
	backupClient?: BackupClient;
	pluginClient?: PluginClient;
	startTime: number;
}

export function createHealthHandler(deps: HealthDeps) {
	return async (_req: Request, res: Response): Promise<void> => {
		const { config, vault, backupClient, pluginClient, startTime } = deps;

		let vaultAccessible = false;
		let fileCount = 0;
		try {
			const files = await vault.listMarkdownFiles();
			fileCount = files.length;
			vaultAccessible = true;
		} catch {
			vaultAccessible = false;
		}

		const integrations: Record<string, unknown> = {};

		if (backupClient) {
			integrations.backup = {
				enabled: true,
				url: config.backupUrl,
				healthy: await backupClient.isHealthy(),
			};
		} else {
			integrations.backup = { enabled: false };
		}

		if (pluginClient) {
			integrations.plugin = {
				enabled: true,
				url: config.pluginMcpUrl,
				healthy: await pluginClient.isHealthy(),
			};
		} else {
			integrations.plugin = { enabled: false };
		}

		const status = vaultAccessible ? "ok" : "degraded";
		const statusCode = vaultAccessible ? 200 : 503;

		res.status(statusCode).json({
			status,
			name: "obaass-mcp",
			version: "0.1.0",
			vault: {
				path: config.vaultPath,
				fileCount,
				accessible: vaultAccessible,
			},
			integrations,
			uptime: Math.floor((Date.now() - startTime) / 1000),
		});
	};
}

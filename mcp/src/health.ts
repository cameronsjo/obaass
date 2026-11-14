import { stat } from "node:fs/promises";
import type { Request, Response } from "express";
import { hasValidBearer } from "./auth.js";
import { type Config, configuredTokens } from "./config.js";
import type { BackupClient } from "./integrations/backup-client.js";
import type { PluginClient } from "./integrations/plugin-client.js";
import { hasTokens } from "./tools/tiers.js";
import type { VaultService } from "./vault/vault-service.js";

export interface HealthDeps {
	config: Config;
	vault: VaultService;
	backupClient?: BackupClient;
	pluginClient?: PluginClient;
	startTime: number;
}

export function createHealthHandler(deps: HealthDeps) {
	return async (req: Request, res: Response): Promise<void> => {
		const { config, vault, backupClient, pluginClient, startTime } = deps;

		// Detail (vault path, internal URLs, scan, probes) only for the full token,
		// or in the local no-token mode. Limited and anonymous callers, and
		// everyone in a limited-only deployment, get status only.
		const tokens = configuredTokens(config);
		const detailed = tokens.full
			? hasValidBearer(req, tokens.full)
			: !hasTokens(tokens) && !config.anonymous;
		if (!detailed) {
			const up = await stat(config.vaultPath).then(
				(s) => s.isDirectory(),
				() => false,
			);
			res
				.status(up ? 200 : 503)
				.json({ status: up ? "ok" : "degraded", name: "obaass-mcp" });
			return;
		}

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

import type { Server } from "node:http";
import type { PluginClient } from "./integrations/plugin-client.js";
import { logger } from "./logger.js";

/** Stop HTTP and MCP concurrently, then await cleanup before successful exit. */
export function installShutdownHandlers(
	httpServer: Server,
	pluginClient: PluginClient | undefined,
	closeMcp: () => Promise<void>,
): void {
	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down", { signal });

		const forceExit = setTimeout(() => {
			logger.warn("Forced exit after shutdown timeout");
			process.exit(1);
		}, 10_000);
		forceExit.unref();

		// MCP close ends active exchanges while HTTP stops accepting connections.
		const mcpClose = closeMcp().catch((err) => {
			logger.warn("Error during MCP shutdown", { error: String(err) });
		});
		httpServer.close(async () => {
			await mcpClose;
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

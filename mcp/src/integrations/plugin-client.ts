import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../logger.js";

export class PluginClient {
	private client: Client;
	private connected = false;

	constructor(private pluginUrl: string) {
		this.client = new Client({ name: "obaass-mcp", version: "0.1.0" });
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			const transport = new StreamableHTTPClientTransport(
				new URL(this.pluginUrl),
			);
			await this.client.connect(transport);
			this.connected = true;
			logger.info("Connected to obsidi-mcp plugin", { url: this.pluginUrl });
		} catch (err) {
			this.connected = false;
			throw new Error(
				`Failed to connect to obsidi-mcp plugin at ${this.pluginUrl}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		if (!this.connected) {
			await this.connect();
		}

		const result = await this.client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text?: string }>;
		const textContent = content?.find((c) => c.type === "text");
		return textContent?.text ?? JSON.stringify(result.content);
	}

	async isHealthy(): Promise<boolean> {
		try {
			if (!this.connected) await this.connect();
			// List tools as a lightweight health check
			await this.client.listTools();
			return true;
		} catch {
			this.connected = false;
			return false;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connected) {
			await this.client.close();
			this.connected = false;
		}
	}
}

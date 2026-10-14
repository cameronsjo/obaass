import { z } from "zod";
import { logger } from "../logger.js";

// obsidi-backup's HealthHandler._send_health() returns only status and uptime.
// Backup timestamps/pipeline fields belong to /status. Older/newer sidecars can
// add arbitrary fields; uptime remains optional for compatibility.
export const backupHealthOutputSchema = z
	.object({
		status: z.string(),
		uptime_seconds: z.number().optional(),
	})
	.passthrough();

export type BackupHealth = z.infer<typeof backupHealthOutputSchema>;

export interface GitCommit {
	hash: string;
	shortHash: string;
	date: string;
	message: string;
}

export class BackupClient {
	private healthCache: { data: BackupHealth; expiry: number } | null = null;

	constructor(private readonly url: string) {}

	/** Base URL of the backup service (for proxying endpoints not yet wrapped). */
	get baseUrl(): string {
		return this.url;
	}

	async health(): Promise<BackupHealth> {
		// Cache health for 30 seconds
		if (this.healthCache && Date.now() < this.healthCache.expiry) {
			return this.healthCache.data;
		}

		const res = await fetch(`${this.baseUrl}/health`);
		if (!res.ok) {
			throw new Error(
				`Backup health check failed: ${res.status} ${res.statusText}`,
			);
		}

		const data = (await res.json()) as BackupHealth;
		this.healthCache = { data, expiry: Date.now() + 30_000 };
		return data;
	}

	async isHealthy(): Promise<boolean> {
		try {
			const health = await this.health();
			return health.status === "healthy";
		} catch (err) {
			logger.warn("Backup health check failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}
}

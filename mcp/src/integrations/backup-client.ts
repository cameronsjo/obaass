import { logger } from "../logger.js";

export interface BackupHealth {
  status: string;
  last_commit?: string;
  last_backup?: string;
  pending_changes?: boolean;
  commits_since_backup?: number;
  uptime_seconds?: number;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  date: string;
  message: string;
}

export class BackupClient {
  private healthCache: { data: BackupHealth; expiry: number } | null = null;

  constructor(private baseUrl: string) {}

  async health(): Promise<BackupHealth> {
    // Cache health for 30 seconds
    if (this.healthCache && Date.now() < this.healthCache.expiry) {
      return this.healthCache.data;
    }

    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`Backup health check failed: ${res.status} ${res.statusText}`);
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

import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { createHealthHandler } from "../src/health.js";
import type { BackupClient } from "../src/integrations/backup-client.js";
import type { VaultService } from "../src/vault/vault-service.js";
import { cleanupVault, makeTempVault } from "./helpers.js";

const TOKEN = "h".repeat(32);

describe("/health with a configured token", () => {
	let vaultPath: string;
	let listMarkdownFiles: ReturnType<typeof vi.fn>;
	let isHealthy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		listMarkdownFiles = vi.fn(async () => ["a.md"]);
		isHealthy = vi.fn(async () => true);
	});
	afterEach(() => cleanupVault(vaultPath));

	async function probe(authorization?: string, path = vaultPath) {
		const handler = createHealthHandler({
			config: {
				vaultPath: path,
				authToken: TOKEN,
				backupUrl: "http://user:pass@backup:8080",
			} as Config,
			vault: { listMarkdownFiles } as unknown as VaultService,
			backupClient: { isHealthy } as unknown as BackupClient,
			startTime: Date.now(),
		});
		let status = 200;
		let body: unknown;
		const res = {
			status(code: number) {
				status = code;
				return res;
			},
			json(value: unknown) {
				body = value;
				return res;
			},
		} as unknown as Response;
		await handler(
			{ headers: authorization ? { authorization } : {} } as Request,
			res,
		);
		return { status, body };
	}

	it("gives callers without the token status only, with no scan or probes", async () => {
		const { status, body } = await probe();
		expect(status).toBe(200);
		expect(body).toEqual({ status: "ok", name: "obaass-mcp" });
		expect(listMarkdownFiles).not.toHaveBeenCalled();
		expect(isHealthy).not.toHaveBeenCalled();
	});

	it("still reports a missing vault to callers without the token", async () => {
		const { status, body } = await probe(undefined, `${vaultPath}/missing`);
		expect(status).toBe(503);
		expect(body).toEqual({ status: "degraded", name: "obaass-mcp" });
	});

	it("gives callers with the token the full report", async () => {
		const { status, body } = await probe(`Bearer ${TOKEN}`);
		expect(status).toBe(200);
		expect(body).toMatchObject({
			vault: { path: vaultPath, fileCount: 1 },
			integrations: { backup: { healthy: true } },
		});
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupClient } from "../../src/integrations/backup-client.js";

const BASE = "http://backup.test:9000";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		statusText: ok ? "OK" : "Error",
		json: async () => body,
	} as unknown as Response;
}

describe("BackupClient", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("exposes the base URL via the baseUrl getter", () => {
		const client = new BackupClient(BASE);
		expect(client.baseUrl).toBe(BASE);
	});

	it("fetches and returns parsed health JSON from /health", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ status: "healthy", pending_changes: false }),
		);
		const client = new BackupClient(BASE);
		const health = await client.health();
		expect(fetchMock).toHaveBeenCalledWith(`${BASE}/health`);
		expect(health).toEqual({ status: "healthy", pending_changes: false });
	});

	it("caches health for 30s — a second call within the window does not re-fetch", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: "healthy" }));
		const client = new BackupClient(BASE);
		await client.health();
		await client.health();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("throws on a non-ok health response", async () => {
		fetchMock.mockResolvedValue(jsonResponse(null, false, 503));
		const client = new BackupClient(BASE);
		await expect(client.health()).rejects.toThrow(/health check failed/i);
	});

	it("isHealthy returns true when status is 'healthy'", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: "healthy" }));
		const client = new BackupClient(BASE);
		expect(await client.isHealthy()).toBe(true);
	});

	it("isHealthy returns false (without throwing) when the fetch fails", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
		const client = new BackupClient(BASE);
		expect(await client.isHealthy()).toBe(false);
	});

	it("isHealthy returns false when status is not 'healthy'", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: "degraded" }));
		const client = new BackupClient(BASE);
		expect(await client.isHealthy()).toBe(false);
	});
});

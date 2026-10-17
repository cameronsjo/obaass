import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cleanupVault, makeTempVault } from "./helpers.js";

describe("loadConfig", () => {
	let vaultPath: string;
	const saved = { ...process.env };

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		// Reset the env keys loadConfig reads.
		for (const k of [
			"VAULT_PATH",
			"MCP_HTTP_PORT",
			"MCP_HTTP_HOST",
			"MCP_HTTP_PATH",
			"LOG_LEVEL",
			"BACKUP_URL",
			"PLUGIN_MCP_URL",
			"DAILY_NOTE_FOLDER",
			"DAILY_NOTE_TEMPLATE",
			"MCP_AUTH_TOKEN",
			"MCP_ALLOW_UNAUTHENTICATED",
		]) {
			delete process.env[k];
		}
	});

	afterEach(async () => {
		process.env = { ...saved };
		await cleanupVault(vaultPath);
	});

	it("loads defaults when only VAULT_PATH is set", () => {
		process.env.VAULT_PATH = vaultPath;
		const config = loadConfig();
		expect(config.vaultPath).toBe(vaultPath);
		expect(config.httpPort).toBe(3000);
		expect(config.httpHost).toBe("127.0.0.1");
		expect(config.authToken).toBeUndefined();
		expect(config.readOnly).toBe(false);
		expect(config.httpPath).toBe("/mcp");
		expect(config.logLevel).toBe("info");
		expect(config.backupUrl).toBeUndefined();
	});

	it("coerces and overrides from env", () => {
		process.env.VAULT_PATH = vaultPath;
		process.env.MCP_HTTP_PORT = "8080";
		process.env.LOG_LEVEL = "debug";
		process.env.BACKUP_URL = "http://backup:9000";
		const config = loadConfig();
		expect(config.httpPort).toBe(8080);
		expect(config.logLevel).toBe("debug");
		expect(config.backupUrl).toBe("http://backup:9000");
	});

	it("throws when VAULT_PATH is missing entirely", () => {
		// zod rejects the undefined value (invalid_type on the vaultPath field).
		expect(() => loadConfig()).toThrow(/vaultPath/i);
	});

	it("throws a clear error when VAULT_PATH does not exist", () => {
		process.env.VAULT_PATH = join(vaultPath, "does-not-exist");
		expect(() => loadConfig()).toThrow(/does not exist/i);
	});

	it("throws when VAULT_PATH points at a file, not a directory", async () => {
		const filePath = join(vaultPath, "afile.md");
		await writeFile(filePath, "x", "utf-8");
		process.env.VAULT_PATH = filePath;
		expect(() => loadConfig()).toThrow(/not a directory/i);
	});

	it("rejects an invalid LOG_LEVEL", () => {
		process.env.VAULT_PATH = vaultPath;
		process.env.LOG_LEVEL = "verbose";
		expect(() => loadConfig()).toThrow();
	});

	describe("MCP access policy", () => {
		const token = "k".repeat(32);

		beforeEach(() => {
			process.env.VAULT_PATH = vaultPath;
		});

		it("refuses to start on a non-loopback bind without a token", () => {
			process.env.MCP_HTTP_HOST = "0.0.0.0";
			expect(() => loadConfig()).toThrow(/MCP_AUTH_TOKEN/);
		});

		it("starts on a non-loopback bind when a token is set", () => {
			process.env.MCP_HTTP_HOST = "0.0.0.0";
			process.env.MCP_AUTH_TOKEN = token;
			const config = loadConfig();
			expect(config.authToken).toBe(token);
			expect(config.readOnly).toBe(false);
		});

		it("starts read-only on a non-loopback bind with the explicit opt-out", () => {
			process.env.MCP_HTTP_HOST = "0.0.0.0";
			process.env.MCP_ALLOW_UNAUTHENTICATED = "true";
			const config = loadConfig();
			expect(config.authToken).toBeUndefined();
			expect(config.readOnly).toBe(true);
			expect(config.accessWarning).toMatch(/read-only/);
		});

		it("treats an empty MCP_AUTH_TOKEN as unset", () => {
			process.env.MCP_AUTH_TOKEN = "";
			expect(loadConfig().authToken).toBeUndefined();
		});

		it.each(["short", " ".repeat(40), `${"k".repeat(31)} x`])(
			"rejects a weak or malformed MCP_AUTH_TOKEN %j",
			(value) => {
				process.env.MCP_AUTH_TOKEN = value;
				expect(() => loadConfig()).toThrow(/MCP_AUTH_TOKEN/);
			},
		);

		it.each(["yes", "1", "TRUE "])(
			"rejects an ambiguous MCP_ALLOW_UNAUTHENTICATED value %j",
			(value) => {
				process.env.MCP_ALLOW_UNAUTHENTICATED = value;
				expect(() => loadConfig()).toThrow(/MCP_ALLOW_UNAUTHENTICATED/);
			},
		);
	});
});

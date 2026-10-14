// Run after npm run build: node tests/smoke-sdk.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const vault = await mkdtemp(join(tmpdir(), "obaass-sdk-smoke-"));
await writeFile(join(vault, "hello.md"), "# Hello\nHello smoke test\n");
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const child = spawn(process.execPath, ["dist/index.js"], {
	env: {
		PATH: process.env.PATH,
		VAULT_PATH: vault,
		MCP_HTTP_HOST: "127.0.0.1",
		MCP_HTTP_PORT: String(port),
		LOG_LEVEL: "info",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(child, "exit");
let output = "";
child.stderr.on("data", (data) => {
	output += data;
});
try {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Startup timeout: ${output}`)),
			30_000,
		);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Early exit ${code}: ${output}`));
		});
		child.stdout.on("data", (data) => {
			output += data;
			if (output.includes('"message":"obaass-mcp ready"')) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	for (const mode of ["legacy", { pin: "2026-07-28" }]) {
		const client = new Client(
			{ name: "process-smoke", version: "1.0.0" },
			{ versionNegotiation: { mode } },
		);
		try {
			await client.connect(
				new StreamableHTTPClientTransport(
					new URL(`http://127.0.0.1:${port}/mcp`),
				),
			);
			const { tools } = await client.listTools();
			assert.equal(tools.length, 16);
			assert.ok(
				tools.some(
					(tool) => tool.name === "search_content" && tool.outputSchema,
				),
			);
			const result = await client.callTool({
				name: "search_content",
				arguments: { query: "smoke test" },
			});
			assert.notEqual(result.isError, true);
			assert.equal(result.structuredContent.count, 1);
			console.log(
				`${client.getProtocolEra()}: listed ${tools.length} tools and received structured search output`,
			);
		} finally {
			await client.close();
		}
	}
	child.kill("SIGTERM");
	const [code, signal] = await exited;
	assert.equal(code, 0, `Shutdown failed (${signal}): ${output}`);
	console.log("Built server process exited cleanly on SIGTERM");
} finally {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await exited;
	}
	await rm(vault, { recursive: true });
}

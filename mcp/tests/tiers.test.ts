import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { type Server, request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Config } from "../src/config.js";
import { createHealthHandler } from "../src/health.js";
import type { BackupClient } from "../src/integrations/backup-client.js";
import type { PluginClient } from "../src/integrations/plugin-client.js";
import { logger } from "../src/logger.js";
import {
	type McpAppOptions,
	RESTRICTED_REQUESTS_PER_MINUTE,
	createMcpApp,
} from "../src/server.js";
import { BackupToolProvider } from "../src/tools/backup-tools.js";
import { ToolRegistry } from "../src/tools/index.js";
import { PluginToolProvider } from "../src/tools/plugin-tools.js";
import {
	RefusalLog,
	resolveAccess,
	tokenFingerprints,
	toolAllowed,
} from "../src/tools/tiers.js";
import { VaultToolProvider } from "../src/tools/vault-tools.js";
import { VaultService } from "../src/vault/vault-service.js";
import { cleanupVault, makeTempVault } from "./helpers.js";

/*
 * Access tiers over real HTTP with every provider registered. The expected tool
 * lists are literal on purpose: deriving them from LIMITED_TOOLS would let a
 * widened allowlist pass its own test.
 */

const FULL_TOKEN = "f".repeat(64);
const LIMITED_TOKEN = "l".repeat(64);

const READ_TOOLS = [
	"file_metadata",
	"get_instructions",
	"read_note",
	"recent_files",
	"search_by_property",
	"search_by_tag",
	"search_content",
	"vault_structure",
	"vault_tags",
];
const LIMITED_EXPECTED = [
	...READ_TOOLS,
	"append_to_note",
	"create_note",
	"daily_note",
].sort();
const ANONYMOUS_EXPECTED = [...READ_TOOLS].sort();
const FULL_EXPECTED = [
	...LIMITED_EXPECTED,
	"backlinks",
	"backup_diff",
	"backup_history",
	"backup_restore",
	"backup_show_file",
	"backup_snapshots",
	"backup_status",
	"delete",
	"delete_note",
	"graph_neighbors",
	"rename",
	"run_dataview_query",
	"semantic_search",
	"set_frontmatter",
].sort();

type Era = "modern" | "legacy";
interface RpcResult {
	status: number;
	body: {
		result?: {
			tools?: Array<{ name: string }>;
			content?: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
		error?: { code: number; message: string };
	};
}

let vaultPath: string;
let server: Server;
let port: number;
let closeMcp: () => Promise<void>;
let head: string;

function git(...args: string[]): string {
	return execFileSync(
		"git",
		["-C", vaultPath, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ encoding: "utf-8" },
	).trim();
}

async function writeNote(rel: string, content: string): Promise<void> {
	await mkdir(join(vaultPath, rel, ".."), { recursive: true });
	await writeFile(join(vaultPath, rel), content);
}

async function snapshot(): Promise<string> {
	const entries = (await readdir(vaultPath, { recursive: true }))
		.map(String)
		.filter((p) => !p.startsWith(".git"))
		.sort();
	const hash = createHash("sha256");
	for (const p of entries) {
		hash.update(p);
		try {
			hash.update(await readFile(join(vaultPath, p)));
		} catch {
			// directory or dangling link: the name alone is enough
		}
	}
	return hash.digest("hex");
}

function makeConfig(extra: Partial<Config> = {}): Config {
	return {
		vaultPath,
		httpPort: 0,
		httpHost: "127.0.0.1",
		httpPath: "/mcp",
		logLevel: "info",
		dailyNoteTemplate: "Templates/daily.md",
		anonymous: false,
		...extra,
	} as Config;
}

async function start(
	options: McpAppOptions,
	configExtra: Partial<Config> = {},
): Promise<void> {
	const config = makeConfig(configExtra);
	const vault = new VaultService(vaultPath);
	const registry = new ToolRegistry();
	registry.register(new VaultToolProvider(vault, config));
	registry.register(
		new BackupToolProvider(
			{
				baseUrl: "http://backup.test",
				health: async () => ({ status: "ok" }),
			} as unknown as BackupClient,
			vaultPath,
		),
	);
	registry.register(
		new PluginToolProvider({
			isHealthy: async () => true,
			callTool: async () => "plugin ok",
		} as unknown as PluginClient),
	);
	const { app, close } = createMcpApp(registry, "/mcp", options);
	closeMcp = close;
	await new Promise<void>((resolve) => {
		server = app.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	port = address.port;
}

function rpc(
	method: string,
	params: Record<string, unknown>,
	token?: string,
	era: Era = "modern",
	extraHeaders: Record<string, string> = {},
): Promise<RpcResult> {
	const modern = era === "modern";
	const headers: Record<string, string> = {
		...extraHeaders,
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": modern ? "2026-07-28" : "2025-11-25",
		...(token && { authorization: `Bearer ${token}` }),
		...(modern && { "Mcp-Method": method }),
		...(modern &&
			typeof params.name === "string" && { "Mcp-Name": params.name }),
	};
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method,
		params: modern
			? {
					...params,
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
						"io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
					},
				}
			: params,
	});
	return new Promise((resolve, reject) => {
		const req = request(
			`http://127.0.0.1:${port}/mcp`,
			{ method: "POST", headers, agent: false },
			(res) => {
				res.setEncoding("utf8");
				let raw = "";
				res.on("data", (c: string) => {
					raw += c;
				});
				res.on("end", () => {
					// SSE framing: take the last `data:` line.
					const text = raw.includes("data:")
						? (raw
								.split("\n")
								.filter((l) => l.startsWith("data:"))
								.pop()
								?.slice(5) ?? "{}")
						: raw || "{}";
					resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
				});
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

async function listTools(token?: string, era: Era = "modern") {
	const res = await rpc("tools/list", {}, token, era);
	return (res.body.result?.tools ?? []).map((t) => t.name).sort();
}

function callTool(
	name: string,
	args: Record<string, unknown>,
	token?: string,
	era: Era = "modern",
) {
	return rpc("tools/call", { name, arguments: args }, token, era);
}

function text(res: RpcResult): string {
	return (res.body.result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

beforeEach(async () => {
	vaultPath = await makeTempVault();
	git("init", "-q");
	await writeNote("note.md", "---\ntitle: t\n---\n\n# Note\n\nhello #tag1");
	await writeNote("ren.md", "rename me");
	await writeNote("del1.md", "delete me");
	await writeNote("del2.md", "delete me too");
	await writeNote("AGENTS.md", "agent instructions");
	await writeNote("Templates/daily.md", "# {{date}}");
	await writeNote(".private/n.md", "SECRET #dottag");
	await writeNote(".hidden.md", "SECRET hidden");
	git("add", "-A");
	git("commit", "-q", "-m", "one");
	await writeNote("note.md", "---\ntitle: t\n---\n\n# Note\n\nhello #tag1 v2");
	git("commit", "-q", "-am", "two");
	head = git("rev-parse", "HEAD");
	await mkdir(join(vaultPath, "notes"));
	await mkdir(join(vaultPath, "Inbox"));
	await symlink(join(vaultPath, "Inbox"), join(vaultPath, "inboxlink"));
	await symlink(join(vaultPath, ".private"), join(vaultPath, "privlink"));
	await symlink(
		join(vaultPath, ".private", "n.md"),
		join(vaultPath, "notes", "link.md"),
	);
	await symlink(
		join(vaultPath, ".git", "config"),
		join(vaultPath, "notes", "gitlink.md"),
	);
});

afterEach(async () => {
	await closeMcp?.();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	await cleanupVault(vaultPath);
	vi.restoreAllMocks();
});

/** A valid input for every tool, so "in tier" can be asserted as success. */
function validArgs(): Record<string, Record<string, unknown>> {
	return {
		read_note: { path: "note.md" },
		search_content: { query: "hello" },
		vault_structure: {},
		file_metadata: { path: "note.md" },
		vault_tags: {},
		search_by_tag: { tag: "tag1" },
		search_by_property: { property: "title" },
		recent_files: {},
		get_instructions: {},
		create_note: { path: "created.md", content: "c" },
		append_to_note: { path: "note.md", content: "more" },
		daily_note: { date: "2026-01-15" },
		set_frontmatter: { path: "note.md", properties: { a: 1 } },
		delete_note: { path: "del1.md" },
		delete: { path: "del2.md" },
		rename: { oldPath: "ren.md", newPath: "ren2.md" },
		backup_status: {},
		backup_history: {},
		backup_show_file: { commit: head, path: "note.md" },
		backup_diff: { commit: head },
		backup_restore: { commit: head, path: "note.md" },
		backup_snapshots: {},
		semantic_search: { query: "x" },
		backlinks: { path: "note.md" },
		graph_neighbors: { path: "note.md" },
		run_dataview_query: { query: "LIST" },
	};
}

describe("tool lists per access", () => {
	it.each<Era>(["modern", "legacy"])(
		"full, limited, and anonymous each list exactly their tools (%s era)",
		async (era) => {
			await start({ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } });
			expect(await listTools(FULL_TOKEN, era)).toEqual(FULL_EXPECTED);
			expect(await listTools(LIMITED_TOKEN, era)).toEqual(LIMITED_EXPECTED);
			await closeMcp();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await start({ tokens: {}, anonymous: true });
			expect(await listTools(undefined, era)).toEqual(ANONYMOUS_EXPECTED);
		},
	);

	it("the loopback no-token mode serves every tool, as before", async () => {
		await start({ tokens: {} });
		expect(await listTools()).toEqual(FULL_EXPECTED);
	});
});

describe("tools/call per access", () => {
	it("full: every tool succeeds", async () => {
		await start({ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } });
		for (const [name, args] of Object.entries(validArgs())) {
			const res = await callTool(name, args, FULL_TOKEN);
			expect(res.body.error, name).toBeUndefined();
			expect(res.body.result?.isError, `${name}: ${text(res)}`).toBeFalsy();
		}
	});

	it.each<Era>(["modern", "legacy"])(
		"limited: in-tier tools succeed; every other tool is unknown and changes nothing (%s era)",
		async (era) => {
			await start({ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } });
			const args = validArgs();
			for (const name of FULL_EXPECTED.filter(
				(n) => !LIMITED_EXPECTED.includes(n),
			)) {
				const before = await snapshot();
				const res = await callTool(name, args[name] ?? {}, LIMITED_TOKEN, era);
				expect(res.body.error, name).toMatchObject({
					code: -32602,
					message: `Tool ${name} not found`,
				});
				expect(await snapshot(), name).toBe(before);
			}
			for (const name of LIMITED_EXPECTED) {
				const res = await callTool(name, args[name] ?? {}, LIMITED_TOKEN, era);
				expect(res.body.error, name).toBeUndefined();
				expect(res.body.result?.isError, `${name}: ${text(res)}`).toBeFalsy();
			}
		},
	);

	it.each<Era>(["modern", "legacy"])(
		"anonymous: reads succeed; writes are unknown (%s era)",
		async (era) => {
			await start({ tokens: {}, anonymous: true });
			const args = validArgs();
			for (const name of ANONYMOUS_EXPECTED) {
				const res = await callTool(name, args[name] ?? {}, undefined, era);
				expect(res.body.result?.isError, `${name}: ${text(res)}`).toBeFalsy();
			}
			for (const name of [
				"create_note",
				"append_to_note",
				"backup_show_file",
			]) {
				const before = await snapshot();
				const res = await callTool(name, args[name] ?? {}, undefined, era);
				expect(res.body.error?.message).toBe(`Tool ${name} not found`);
				expect(await snapshot()).toBe(before);
			}
		},
	);
});

describe("limited path policy", () => {
	beforeEach(() =>
		start({ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } }),
	);

	async function refused(name: string, args: Record<string, unknown>) {
		const before = await snapshot();
		const gitConfig = await readFile(join(vaultPath, ".git", "config"), "utf8");
		const res = await callTool(name, args, LIMITED_TOKEN);
		expect(res.body.result?.isError, `${name} ${JSON.stringify(args)}`).toBe(
			true,
		);
		expect(text(res)).toMatch(/path policy|not permitted/i);
		for (const value of Object.values(args)) {
			if (typeof value === "string" && value.includes("/")) {
				expect(text(res)).not.toContain(value);
			}
		}
		expect(await snapshot()).toBe(before);
		expect(await readFile(join(vaultPath, ".git", "config"), "utf8")).toBe(
			gitConfig,
		);
		return res;
	}

	it("refuses dot paths on read and write", async () => {
		await refused("read_note", { path: ".private/n.md" });
		await refused("read_note", { path: ".hidden.md" });
		await refused("file_metadata", { path: ".private/n.md" });
		await refused("vault_structure", { path: ".private" });
		await refused("append_to_note", { path: ".hidden.md", content: "x" });
		await refused("create_note", { path: ".private/new.md", content: "x" });
	});

	it("refuses a read or append through a link whose target is under a dot folder", async () => {
		await refused("read_note", { path: "notes/link.md" });
		await refused("append_to_note", { path: "notes/gitlink.md", content: "x" });
		await refused("append_to_note", {
			path: "notes/gitlink.md",
			content: "x",
			heading: "core",
		});
	});

	it("refuses non-.md writes, instruction files, and the daily template", async () => {
		await refused("create_note", { path: "scripts/run.js", content: "x" });
		await refused("create_note", { path: "CLAUDE.md", content: "x" });
		await refused("create_note", { path: "sub/dir/claude.MD", content: "x" });
		await refused("create_note", { path: "deep/GEMINI.md", content: "x" });
		await refused("create_note", { path: "CLAUDE.local.md", content: "x" });
		await refused("create_note", {
			path: "a/AGENTS.override.md",
			content: "x",
		});
		await refused("create_note", { path: "AGENTS.md", content: "x" });
		await refused("create_note", { path: "notes/QWEN.md", content: "x" });
		await refused("create_note", { path: "CLAUDE.md/x.md", content: "x" });
		await refused("create_note", {
			path: "Daily Notes/2026-09-09.md/x.md",
			content: "x",
		});
		await refused("append_to_note", { path: "AGENTS.md", content: "x" });
		await refused("append_to_note", {
			path: "Templates/daily.md",
			content: "<%* x %>",
		});
	});

	it("follows an in-vault directory link to a normal folder but refuses one into a dot folder", async () => {
		const ok = await callTool(
			"create_note",
			{ path: "inboxlink/new.md", content: "via link" },
			LIMITED_TOKEN,
		);
		expect(ok.body.result?.isError, text(ok)).toBeFalsy();
		expect(await readFile(join(vaultPath, "Inbox", "new.md"), "utf8")).toBe(
			"via link",
		);
		await refused("create_note", { path: "privlink/new.md", content: "x" });
	});

	it("refuses overwrite and regex search", async () => {
		await refused("create_note", {
			path: "note.md",
			content: "clobber",
			overwrite: true,
		});
		await refused("search_content", { query: "(a+)+$", regex: true });
	});

	it("hides dot entries from listings and searches", async () => {
		const structure = text(
			await callTool("vault_structure", {}, LIMITED_TOKEN),
		);
		expect(structure).not.toMatch(/\.private|\.hidden/);
		const recent = text(await callTool("recent_files", {}, LIMITED_TOKEN));
		expect(recent).not.toMatch(/\.private|\.hidden/);
		const search = text(
			await callTool("search_content", { query: "SECRET" }, LIMITED_TOKEN),
		);
		expect(search).not.toContain("SECRET");
		const tags = text(await callTool("vault_tags", {}, LIMITED_TOKEN));
		expect(tags).not.toContain("dottag");
		const byTag = text(
			await callTool("search_by_tag", { tag: "dottag" }, LIMITED_TOKEN),
		);
		expect(byTag).not.toContain(".private");
	});

	it("leaves the full tier able to see and write all of these", async () => {
		expect(
			text(await callTool("read_note", { path: ".private/n.md" }, FULL_TOKEN)),
		).toContain("SECRET");
		expect(text(await callTool("vault_structure", {}, FULL_TOKEN))).toContain(
			".private",
		);
		const created = await callTool(
			"create_note",
			{ path: "scripts/run.js", content: "x" },
			FULL_TOKEN,
		);
		expect(created.body.result?.isError).toBeFalsy();
		const search = text(
			await callTool(
				"search_content",
				{ query: "hel+o", regex: true },
				FULL_TOKEN,
			),
		);
		expect(search).toContain("note.md");
	});

	it("never logs a refused path value", async () => {
		const lines: string[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const) {
			vi.spyOn(logger, level).mockImplementation((...a: unknown[]) => {
				lines.push(JSON.stringify(a));
			});
		}
		await callTool("read_note", { path: ".private/n.md" }, LIMITED_TOKEN);
		await callTool(
			"create_note",
			{ path: "sub/CLAUDE.md", content: "x" },
			LIMITED_TOKEN,
		);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).not.toMatch(/\.private|sub\/CLAUDE/);
	});
});

describe("full tier: no writes to hidden paths", () => {
	beforeEach(() =>
		start({ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } }),
	);

	it("refuses every write route into a hidden folder or file, and changes nothing", async () => {
		await writeNote(".obsidian/plugins/x/main.js", "plugin();");
		const gitConfig = await readFile(join(vaultPath, ".git", "config"), "utf8");
		for (const [name, args] of [
			["create_note", { path: ".obsidian/plugins/x/new.md", content: "x" }],
			[
				"create_note",
				{
					path: ".obsidian/plugins/x/main.js",
					content: "evil();",
					overwrite: true,
				},
			],
			["append_to_note", { path: ".hidden.md", content: "x" }],
			["append_to_note", { path: "notes/gitlink.md", content: "[core]" }],
			["set_frontmatter", { path: ".private/n.md", properties: { a: 1 } }],
			["delete_note", { path: ".hidden.md" }],
			[
				"rename",
				{ oldPath: "note.md", newPath: ".obsidian/plugins/x/main.md" },
			],
			["rename", { oldPath: ".private/n.md", newPath: "moved.md" }],
		] as const) {
			const before = await snapshot();
			const res = await callTool(name, args, FULL_TOKEN);
			expect(res.body.result?.isError, `${name} ${JSON.stringify(args)}`).toBe(
				true,
			);
			expect(text(res)).toMatch(/dot_segment/);
			expect(await snapshot()).toBe(before);
		}
		expect(await readFile(join(vaultPath, ".git", "config"), "utf8")).toBe(
			gitConfig,
		);
		expect(
			await readFile(join(vaultPath, ".obsidian/plugins/x/main.js"), "utf8"),
		).toBe("plugin();");
	});

	it("still reads hidden paths, and a rename skips links inside hidden notes", async () => {
		expect(
			text(await callTool("read_note", { path: ".private/n.md" }, FULL_TOKEN)),
		).toContain("SECRET");
		await writeNote(".private/links.md", "see [[ren]]");
		await writeNote("visible.md", "see [[ren]]");
		const res = await callTool(
			"rename",
			{ oldPath: "ren.md", newPath: "ren3.md" },
			FULL_TOKEN,
		);
		expect(res.body.result?.isError, text(res)).toBeFalsy();
		expect(await readFile(join(vaultPath, "visible.md"), "utf8")).toBe(
			"see [[ren3]]",
		);
		expect(await readFile(join(vaultPath, ".private/links.md"), "utf8")).toBe(
			"see [[ren]]",
		);
	});
});

describe("limited write-folder allowlist (MCP_LIMITED_WRITE_DIRS)", () => {
	beforeEach(() =>
		start(
			{ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } },
			{ limitedWriteDirs: ["Inbox"], dailyNoteTemplate: "Templates/daily" },
		),
	);

	it("allows writes only under the listed folders", async () => {
		const ok = await callTool(
			"create_note",
			{ path: "Inbox/a.md", content: "x" },
			LIMITED_TOKEN,
		);
		expect(ok.body.result?.isError, text(ok)).toBeFalsy();
		for (const [name, args] of [
			["create_note", { path: "b.md", content: "x" }],
			["create_note", { path: "Inboxer/c.md", content: "x" }],
			["create_note", { path: "inboxlink/d.md", content: "x" }],
			["append_to_note", { path: "note.md", content: "x" }],
			["daily_note", { date: "2026-01-16" }],
		] as const) {
			const before = await snapshot();
			const res = await callTool(name, args, LIMITED_TOKEN);
			expect(res.body.result?.isError, `${name} ${JSON.stringify(args)}`).toBe(
				true,
			);
			expect(text(res)).toMatch(/write_scope/);
			expect(await snapshot()).toBe(before);
		}
	});

	it("does not restrict the full tier", async () => {
		const res = await callTool(
			"create_note",
			{ path: "b.md", content: "x" },
			FULL_TOKEN,
		);
		expect(res.body.result?.isError).toBeFalsy();
	});

	it("protects a dotted template name under its .md file", async () => {
		await closeMcp();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await writeNote("Templates/daily.v2.md", "# {{date}}");
		await start(
			{ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } },
			{ dailyNoteTemplate: "/Templates/daily.v2" },
		);
		const res = await callTool(
			"append_to_note",
			{ path: "Templates/daily.v2.md", content: "<%* x %>" },
			LIMITED_TOKEN,
		);
		expect(text(res)).toMatch(/protected_path/);
	});

	it("protects an extensionless template setting under its .md name", async () => {
		const res = await callTool(
			"append_to_note",
			{ path: "Templates/daily.md", content: "x" },
			LIMITED_TOKEN,
		);
		expect(text(res)).toMatch(/protected_path/);
	});
});

describe("restricted error text and write audit", () => {
	beforeEach(() =>
		start({ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } }),
	);

	it("never returns the absolute vault path to a restricted caller", async () => {
		const limited = text(
			await callTool("read_note", { path: "missing.md" }, LIMITED_TOKEN),
		);
		expect(limited).toMatch(/not found/);
		expect(limited).not.toContain(vaultPath);
		const full = text(
			await callTool("read_note", { path: "missing.md" }, FULL_TOKEN),
		);
		expect(full).toContain("ENOENT");
	});

	it("records the daily note a restricted daily_note created, and no line for a write that did nothing", async () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		await callTool("daily_note", { date: "2026-02-01" }, LIMITED_TOKEN);
		await callTool("daily_note", { date: "2026-02-01" }, LIMITED_TOKEN);
		const exists = await callTool(
			"create_note",
			{ path: "note.md", content: "x" },
			LIMITED_TOKEN,
		);
		expect(exists.body.result?.isError).toBe(true);
		const applied = info.mock.calls
			.filter((c) => c[0] === "Restricted write applied")
			.map((c) => (c[1] as { target?: string }).target);
		expect(applied).toEqual(["Daily Notes/2026-02-01.md"]);
	});

	it("records the target of a successful restricted write, not its content", async () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		await callTool(
			"create_note",
			{ path: "audit.md", content: "SECRET-BODY" },
			LIMITED_TOKEN,
		);
		const applied = info.mock.calls.find(
			(c) => c[0] === "Restricted write applied",
		);
		expect(applied?.[1]).toMatchObject({
			tool: "create_note",
			tier: "limited",
			target: "audit.md",
		});
		expect(JSON.stringify(info.mock.calls)).not.toContain("SECRET-BODY");
	});
});

describe("restricted error text for errors that are not refusals", () => {
	it("returns a fixed message, never the raw error text, to a restricted caller", async () => {
		const registry = new ToolRegistry();
		registry.register({
			id: "fixture",
			name: "fixture",
			getTools: () => [
				{
					name: "read_note",
					description: "throws",
					inputSchema: z.object({}),
					handler: async () => {
						throw new TypeError("SECRET note text and /abs/vault/path");
					},
				},
			],
		});
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const { app, close } = createMcpApp(registry, "/mcp", {
			tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN },
		});
		closeMcp = close;
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		port = address.port;
		const limited = text(await callTool("read_note", {}, LIMITED_TOKEN));
		expect(limited).toContain("the call failed (TypeError)");
		expect(limited).not.toContain("SECRET");
		expect(JSON.stringify(error.mock.calls)).not.toContain("SECRET");
		const full = text(await callTool("read_note", {}, FULL_TOKEN));
		expect(full).toContain("SECRET");
	});
});

describe("authentication and the mode table", () => {
	it("a limited-only deployment still requires a token", async () => {
		await start({ tokens: { limited: LIMITED_TOKEN } });
		expect((await rpc("tools/list", {})).status).toBe(401);
		expect((await rpc("tools/list", {}, FULL_TOKEN)).status).toBe(401);
		expect(await listTools(LIMITED_TOKEN)).toEqual(LIMITED_EXPECTED);
	});

	it("a wrong token is refused before dispatch", async () => {
		await start({ tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } });
		expect((await rpc("tools/list", {}, "x".repeat(64))).status).toBe(401);
	});

	it("resolveAccess takes the tier only from a configured token's clientId", () => {
		const both = { tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN } };
		expect(resolveAccess(both, undefined)).toBeUndefined();
		expect(resolveAccess(both, { clientId: "Full" })).toBeUndefined();
		expect(resolveAccess(both, { clientId: "admin" })).toBeUndefined();
		expect(resolveAccess(both, { clientId: "anonymous" })).toBeUndefined();
		expect(resolveAccess(both, { clientId: "full" })).toBe("full");
		expect(resolveAccess(both, { clientId: "limited" })).toBe("limited");
		const limitedOnly = { tokens: { limited: LIMITED_TOKEN } };
		expect(resolveAccess(limitedOnly, { clientId: "full" })).toBeUndefined();
		expect(resolveAccess({ tokens: {} }, undefined)).toBe("full");
		expect(resolveAccess({ tokens: {}, anonymous: true }, undefined)).toBe(
			"anonymous",
		);
		expect(
			resolveAccess({ tokens: {}, anonymous: true }, { clientId: "full" }),
		).toBe("anonymous");
	});

	it("toolAllowed refuses unknown access values", () => {
		expect(toolAllowed(undefined, "read_note")).toBe(false);
		expect(toolAllowed("Full" as never, "read_note")).toBe(false);
		expect(toolAllowed("limited", "delete_note")).toBe(false);
		expect(toolAllowed("full", "delete_note")).toBe(true);
	});
});

describe("/health detail", () => {
	async function probe(config: Partial<Config>, authorization?: string) {
		const handler = createHealthHandler({
			config: makeConfig(config),
			vault: new VaultService(vaultPath),
			startTime: Date.now(),
		});
		let body: Record<string, unknown> = {};
		const res = {
			status: () => res,
			json: (b: Record<string, unknown>) => {
				body = b;
				return res;
			},
		};
		await handler(
			{ headers: authorization ? { authorization } : {} } as never,
			res as never,
		);
		return body;
	}

	it("gives detail only to the full token", async () => {
		const both = { authToken: FULL_TOKEN, limitedAuthToken: LIMITED_TOKEN };
		expect(await probe(both, `Bearer ${FULL_TOKEN}`)).toHaveProperty("vault");
		expect(await probe(both, `Bearer ${LIMITED_TOKEN}`)).not.toHaveProperty(
			"vault",
		);
		expect(await probe(both)).not.toHaveProperty("vault");
	});

	it("gives status only to everyone in a limited-only deployment", async () => {
		const limitedOnly = { limitedAuthToken: LIMITED_TOKEN };
		expect(await probe(limitedOnly)).not.toHaveProperty("vault");
		expect(
			await probe(limitedOnly, `Bearer ${LIMITED_TOKEN}`),
		).not.toHaveProperty("vault");
	});

	it("keeps detail in the loopback no-token mode and hides it in anonymous mode", async () => {
		expect(await probe({})).toHaveProperty("vault");
		expect(await probe({ anonymous: true })).not.toHaveProperty("vault");
	});
});

describe("rate limit for restricted access", () => {
	it("defaults the cap to 120 messages per minute", () => {
		expect(RESTRICTED_REQUESTS_PER_MINUTE).toBe(120);
	});

	it("answers 429 past the per-minute cap for limited, never for full", async () => {
		await start({
			tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN },
			restrictedRequestsPerMinute: 3,
		});
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) {
			statuses.push((await rpc("tools/list", {}, LIMITED_TOKEN)).status);
		}
		expect(statuses).toEqual([200, 200, 200, 429]);
		for (let i = 0; i < 5; i++) {
			expect((await rpc("tools/list", {}, FULL_TOKEN)).status).toBe(200);
		}
	});

	it("counts every message in a batch toward the cap", async () => {
		await start({ tokens: { limited: LIMITED_TOKEN } });
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const read = vi.spyOn(VaultService.prototype, "readFile");
		const batch = (n: number, offset: number) =>
			Array.from({ length: n }, (_, i) => ({
				jsonrpc: "2.0",
				id: offset + i,
				method: "tools/call",
				params: { name: "read_note", arguments: { path: "note.md" } },
			}));
		const post = (body: unknown) =>
			fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": "2025-11-25",
					authorization: `Bearer ${LIMITED_TOKEN}`,
				},
				body: JSON.stringify(body),
			});
		expect((await post(batch(100, 0))).status).toBe(200);
		const callsAfterFirst = read.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThanOrEqual(100);
		expect((await post(batch(30, 100))).status).toBe(429);
		expect(read.mock.calls.length).toBe(callsAfterFirst);
	});
});

describe("refusal audit trail over HTTP", () => {
	it("logs one warn line per refusal kind, with the server-assigned request id", async () => {
		await start({
			tokens: { full: FULL_TOKEN, limited: LIMITED_TOKEN },
			restrictedRequestsPerMinute: 3,
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await callTool("delete_note", { path: "note.md" }, LIMITED_TOKEN);
		await callTool("read_note", { path: ".private/n.md" }, LIMITED_TOKEN);
		await rpc("tools/list", {}, LIMITED_TOKEN);
		await rpc("tools/list", {}, LIMITED_TOKEN);
		const lines = warn.mock.calls
			.filter((c) => c[0] === "Refused MCP request outside its access tier")
			.map((c) => c[1] as Record<string, unknown>);
		const byKind = Object.fromEntries(lines.map((l) => [l.refusalKind, l]));
		expect(byKind.out_of_tier).toMatchObject({
			tier: "limited",
			tool: "delete_note",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(byKind.dot_segment).toMatchObject({
			tier: "limited",
			tool: "read_note",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(byKind.rate_limited).toMatchObject({
			tier: "limited",
			tool: "all",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(lines).toHaveLength(3);
	});
});

describe("request ids on audit lines", () => {
	it("records a server-assigned id and a well-formed upstream id, never a client-chosen request id", async () => {
		await start({
			tokens: { limited: LIMITED_TOKEN },
			upstreamRequestIdHeader: "x-request-id",
		});
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		await rpc(
			"tools/call",
			{ name: "create_note", arguments: { path: "a.md", content: "x" } },
			LIMITED_TOKEN,
			"modern",
			{ "x-request-id": "gw-123", "x-obaass-request-id": "forged" },
		);
		await rpc(
			"tools/call",
			{ name: "create_note", arguments: { path: "b.md", content: "x" } },
			LIMITED_TOKEN,
			"modern",
			{ "x-request-id": "bad id with spaces" },
		);
		const lines = info.mock.calls
			.filter((c) => c[0] === "Dispatching write tool")
			.map((c) => c[1] as Record<string, unknown>);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			tool: "create_note",
			tier: "limited",
			upstreamRequestId: "gw-123",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(lines[0]?.requestId).not.toBe("forged");
		expect(lines[1]).not.toHaveProperty("upstreamRequestId");
	});
});

describe("refusal log", () => {
	it("logs a key once per window and flushes the count", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let clock = 0;
		const log = new RefusalLog(new Set(["delete_note", "rename"]), () => clock);
		for (let i = 0; i < 5; i++) {
			log.record("limited", "delete_note", "out_of_tier", `r${i}`);
		}
		log.record("limited", "rename", "out_of_tier", "r9");
		expect(warn).toHaveBeenCalledTimes(2);
		clock = 60_000;
		log.flush();
		const flushed = warn.mock.calls.slice(2).map((c) => c[1]);
		expect(flushed).toEqual([
			expect.objectContaining({
				tool: "delete_note",
				tier: "limited",
				refusalKind: "out_of_tier",
				count: 4,
			}),
		]);
	});

	it("logs an unregistered tool name as unknown with its length", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const log = new RefusalLog(new Set(["read_note"]), () => 0);
		log.record("limited", "x".repeat(5000), "out_of_tier", "r1");
		expect(warn.mock.calls[0]?.[1]).toMatchObject({
			tool: "unknown",
			toolNameLength: 5000,
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("xxxxxxxx");
	});
});

describe("token fingerprints", () => {
	it("are domain-separated 8-hex digests that contain no token text", () => {
		const prints = tokenFingerprints({
			full: FULL_TOKEN,
			limited: LIMITED_TOKEN,
		});
		const expected = createHash("sha256")
			.update(`obaass-mcp:token-fp:v1:${LIMITED_TOKEN}`)
			.digest("hex")
			.slice(0, 8);
		expect(prints).toEqual([
			{ tier: "full", fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) },
			{ tier: "limited", fingerprint: expected },
		]);
		const plain = createHash("sha256")
			.update(LIMITED_TOKEN)
			.digest("hex")
			.slice(0, 8);
		expect(expected).not.toBe(plain);
		expect(JSON.stringify(prints)).not.toContain("llll");
	});
});

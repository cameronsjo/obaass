import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupClient } from "../../src/integrations/backup-client.js";
import { BackupToolProvider } from "../../src/tools/backup-tools.js";

// Mock node:child_process before the module under test is loaded.
// Without util.promisify.custom, promisify uses standard last-arg-callback:
// cb(null, resolvedValue). We pass { stdout } as the resolved value so that
// `const { stdout } = await execFileAsync(...)` works correctly in the source.
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

/** Typed handle to the mocked execFile. */
const mockExecFile = vi.mocked(
	execFile as (
		file: string,
		args: string[],
		options: object,
		callback: (err: Error | null, result: { stdout: string }) => void,
	) => void,
);

/** Stub BackupClient — only the fields BackupToolProvider actually calls.
 * The double-cast is the standard vitest partial-stub pattern: we supply only
 * the surface exercised by the provider and intentionally skip the rest.
 */
function makeStubClient(baseUrl = "http://backup.test"): BackupClient {
	// intentional partial stub — BackupClient is not instantiated via its constructor
	const stub = {
		health: vi.fn().mockResolvedValue({ status: "healthy" }),
		isHealthy: vi.fn().mockResolvedValue(true),
		baseUrl,
	};
	return stub as unknown as BackupClient;
}

/** Return the first text content block from a tool call. */
async function callTool(
	provider: BackupToolProvider,
	name: string,
	params: Record<string, unknown>,
): Promise<string> {
	const tool = provider.getTools().find((t) => t.name === name);
	if (!tool) throw new Error(`Tool '${name}' not found`);
	const result = await tool.handler(params);
	const block = result.content[0];
	if (block.type !== "text") throw new Error("expected text content");
	return block.text;
}

describe("BackupToolProvider — commit-hash injection rejection", () => {
	let provider: BackupToolProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new BackupToolProvider(makeStubClient(), "/vault");
	});

	const INVALID_HASHES = [
		"abc; rm -rf /",
		"HEAD",
		"$(evil)",
		"main",
		"",
		"abc", // only 3 hex chars (min is 4)
	];

	for (const bad of INVALID_HASHES) {
		it(`backup_show_file rejects commit='${bad || "(empty)"}' without calling git`, async () => {
			const text = await callTool(provider, "backup_show_file", {
				commit: bad,
				path: "note.md",
			});
			expect(text).toMatch(/invalid commit hash/i);
			expect(mockExecFile).not.toHaveBeenCalled();
		});

		it(`backup_diff rejects commit='${bad || "(empty)"}' without calling git`, async () => {
			const text = await callTool(provider, "backup_diff", { commit: bad });
			expect(text).toMatch(/invalid commit hash/i);
			expect(mockExecFile).not.toHaveBeenCalled();
		});

		it(`backup_restore rejects commit='${bad || "(empty)"}' without calling git`, async () => {
			const text = await callTool(provider, "backup_restore", {
				commit: bad,
				path: "note.md",
			});
			expect(text).toMatch(/invalid commit hash/i);
			expect(mockExecFile).not.toHaveBeenCalled();
		});
	}

	it("backup_diff also rejects an invalid compareTo hash without calling git", async () => {
		const text = await callTool(provider, "backup_diff", {
			commit: "abc1234",
			compareTo: "HEAD~1",
		});
		expect(text).toMatch(/invalid.*compareTo.*hash/i);
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it("accepts a valid 7-char hex hash and invokes git", async () => {
		mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
			cb(null, { stdout: "file content" });
		});
		const text = await callTool(provider, "backup_show_file", {
			commit: "abc1234",
			path: "note.md",
		});
		expect(mockExecFile).toHaveBeenCalledOnce();
		expect(text).toBe("file content");
	});

	it("accepts a valid 40-char hex hash and invokes git", async () => {
		mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
			cb(null, { stdout: "restored content" });
		});
		const text = await callTool(provider, "backup_show_file", {
			commit: "a".repeat(40),
			path: "note.md",
		});
		expect(mockExecFile).toHaveBeenCalledOnce();
		expect(text).toBe("restored content");
	});
});

describe("BackupToolProvider — backup_history / parseGitLog (indirect)", () => {
	const VAULT_PATH = "/test-vault";
	// Format: %H%n%h%n%aI%n%s%n--- (one entry per block, separated by "---\n")
	const MOCK_LOG =
		"abc123def456\nabc123\n2026-06-05T12:00:00Z\nFirst commit\n---\n" +
		"def789abc012\ndef789\n2026-06-04T10:30:00Z\nSecond commit\n---\n";

	let provider: BackupToolProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
			cb(null, { stdout: MOCK_LOG });
		});
		provider = new BackupToolProvider(makeStubClient(), VAULT_PATH);
	});

	it("parses git log output into a structured commits array", async () => {
		const text = await callTool(provider, "backup_history", { count: 5 });
		const data = JSON.parse(text) as {
			count: number;
			commits: Array<{
				hash: string;
				shortHash: string;
				date: string;
				message: string;
			}>;
		};
		expect(data.count).toBe(2);
		expect(data.commits[0]).toEqual({
			hash: "abc123def456",
			shortHash: "abc123",
			date: "2026-06-05T12:00:00Z",
			message: "First commit",
		});
		expect(data.commits[1]).toEqual({
			hash: "def789abc012",
			shortHash: "def789",
			date: "2026-06-04T10:30:00Z",
			message: "Second commit",
		});
	});

	it("passes -C vaultPath as the first args to git", async () => {
		await callTool(provider, "backup_history", { count: 3 });
		const [_cmd, args] = mockExecFile.mock.calls[0];
		expect(args[0]).toBe("-C");
		expect(args[1]).toBe(VAULT_PATH);
	});

	it("passes the correct -n<count> flag", async () => {
		await callTool(provider, "backup_history", { count: 5 });
		const [_cmd, args] = mockExecFile.mock.calls[0];
		expect(args).toContain("-n5");
	});

	it("clamps an absurd count to 1000", async () => {
		await callTool(provider, "backup_history", { count: 99999 });
		const [_cmd, args] = mockExecFile.mock.calls[0];
		expect(args).toContain("-n1000");
	});

	it("defaults to 20 when count is omitted", async () => {
		await callTool(provider, "backup_history", {});
		const [_cmd, args] = mockExecFile.mock.calls[0];
		expect(args).toContain("-n20");
	});

	it("passes -- file when the file param is given", async () => {
		await callTool(provider, "backup_history", {
			count: 10,
			file: "notes/journal.md",
		});
		const [_cmd, args] = mockExecFile.mock.calls[0];
		expect(args).toContain("--");
		expect(args).toContain("notes/journal.md");
	});
});

describe("BackupToolProvider — backup_status", () => {
	it("calls client.health() and returns the result as JSON", async () => {
		const stubClient = makeStubClient();
		vi.mocked(stubClient.health).mockResolvedValue({
			status: "healthy",
			last_commit: "abc1234",
			pending_changes: false,
		});
		const provider = new BackupToolProvider(stubClient, "/vault");
		const text = await callTool(provider, "backup_status", {});
		const data = JSON.parse(text) as Record<string, unknown>;
		expect(data.status).toBe("healthy");
		expect(data.last_commit).toBe("abc1234");
		expect(vi.mocked(stubClient.health)).toHaveBeenCalledOnce();
	});
});

describe("BackupToolProvider — backup_snapshots", () => {
	it("returns text containing the /ui/snapshots URL for the configured baseUrl", async () => {
		const client = makeStubClient("http://backup.sjo.lol");
		const provider = new BackupToolProvider(client, "/vault");
		const text = await callTool(provider, "backup_snapshots", {});
		expect(text).toContain("http://backup.sjo.lol/ui/snapshots");
	});
});

describe("BackupToolProvider — tool-name set", () => {
	it("exposes the expected backup tool names", () => {
		const provider = new BackupToolProvider(makeStubClient(), "/vault");
		const names = provider.getTools().map((t) => t.name);
		expect(names).toContain("backup_status");
		expect(names).toContain("backup_history");
		expect(names).toContain("backup_show_file");
		expect(names).toContain("backup_diff");
		expect(names).toContain("backup_restore");
		expect(names).toContain("backup_snapshots");
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

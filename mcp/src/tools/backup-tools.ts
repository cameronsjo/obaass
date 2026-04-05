import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition, ToolProvider } from "./types.js";
import type { BackupClient } from "../integrations/backup-client.js";

const execFileAsync = promisify(execFile);

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Run a git command safely against the vault directory.
 * Uses execFile (not exec) to prevent shell injection.
 */
async function git(vaultPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", vaultPath, ...args], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export class BackupToolProvider implements ToolProvider {
  id = "backup";
  name = "Backup Tools";

  constructor(
    private client: BackupClient,
    private vaultPath: string,
  ) {}

  getTools(): ToolDefinition[] {
    return [
      this.backupStatus(),
      this.backupHistory(),
      this.backupShowFile(),
      this.backupDiff(),
      this.backupRestore(),
      this.backupSnapshots(),
    ];
  }

  private backupStatus(): ToolDefinition {
    return {
      name: "backup_status",
      description: "Get the current status of the vault backup system (last commit, last backup, health).",
      inputSchema: z.object({}),
      handler: async () => {
        const health = await this.client.health();
        return jsonResult(health);
      },
    };
  }

  private backupHistory(): ToolDefinition {
    return {
      name: "backup_history",
      description: "List recent git commits from the vault backup history.",
      inputSchema: z.object({
        count: z.number().optional().describe("Number of commits to show (default: 20)"),
        file: z.string().optional().describe("Filter to commits affecting this file path"),
      }),
      handler: async (params) => {
        const { count = 20, file } = params as { count?: number; file?: string };
        const format = "--format=%H%n%h%n%aI%n%s%n---";
        const args = ["log", format, `-n${count}`];
        if (file) args.push("--", file);

        const output = await git(this.vaultPath, args);
        const commits = parseGitLog(output);
        return jsonResult({ count: commits.length, commits });
      },
    };
  }

  private backupShowFile(): ToolDefinition {
    return {
      name: "backup_show_file",
      description: "Read a file's content at a specific git commit.",
      inputSchema: z.object({
        commit: z.string().describe("Git commit hash (full or short)"),
        path: z.string().describe("Vault-relative file path"),
      }),
      handler: async (params) => {
        const { commit, path } = params as { commit: string; path: string };
        // Validate commit hash format to prevent injection via git rev-parse args
        if (!/^[a-f0-9]{4,40}$/i.test(commit)) {
          return textResult("Error: Invalid commit hash format.");
        }
        const content = await git(this.vaultPath, ["show", `${commit}:${path}`]);
        return textResult(content);
      },
    };
  }

  private backupDiff(): ToolDefinition {
    return {
      name: "backup_diff",
      description: "Show the diff for a file between two commits, or a commit and the current state.",
      inputSchema: z.object({
        commit: z.string().describe("Git commit hash to diff from"),
        path: z.string().optional().describe("File path to diff (omit for all changes in commit)"),
        compareTo: z.string().optional().describe("Compare to this commit (default: parent commit)"),
      }),
      handler: async (params) => {
        const { commit, path, compareTo } = params as {
          commit: string;
          path?: string;
          compareTo?: string;
        };
        if (!/^[a-f0-9]{4,40}$/i.test(commit)) {
          return textResult("Error: Invalid commit hash format.");
        }
        if (compareTo && !/^[a-f0-9]{4,40}$/i.test(compareTo)) {
          return textResult("Error: Invalid compareTo commit hash format.");
        }

        const range = compareTo ? `${commit}..${compareTo}` : `${commit}~1..${commit}`;
        const args = ["diff", range];
        if (path) args.push("--", path);

        const output = await git(this.vaultPath, args);
        return textResult(output || "No differences found.");
      },
    };
  }

  private backupRestore(): ToolDefinition {
    return {
      name: "backup_restore",
      description: "Restore a file from a previous git commit. Overwrites the current version.",
      inputSchema: z.object({
        commit: z.string().describe("Git commit hash to restore from"),
        path: z.string().describe("Vault-relative file path to restore"),
      }),
      handler: async (params) => {
        const { commit, path } = params as { commit: string; path: string };
        if (!/^[a-f0-9]{4,40}$/i.test(commit)) {
          return textResult("Error: Invalid commit hash format.");
        }
        await git(this.vaultPath, ["checkout", commit, "--", path]);
        return textResult(`Restored '${path}' from commit ${commit}.`);
      },
    };
  }

  private backupSnapshots(): ToolDefinition {
    return {
      name: "backup_snapshots",
      description: "List restic backup snapshots (proxied from obsidi-backup).",
      inputSchema: z.object({}),
      handler: async () => {
        try {
          const res = await fetch(`${this.client["baseUrl"]}/ui/snapshots`);
          if (!res.ok) {
            return textResult(`Error fetching snapshots: ${res.status} ${res.statusText}`);
          }
          // The endpoint returns HTML; extract snapshot data from it
          const html = await res.text();
          return textResult(
            "Restic snapshots are available via the backup web UI. " +
              "Direct JSON API is not yet implemented in obsidi-backup. " +
              `View them at: ${this.client["baseUrl"]}/ui/snapshots`,
          );
        } catch (err) {
          return textResult(`Error connecting to backup service: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  }
}

function parseGitLog(output: string): Array<{ hash: string; shortHash: string; date: string; message: string }> {
  const commits: Array<{ hash: string; shortHash: string; date: string; message: string }> = [];
  const entries = output.split("---\n").filter((e) => e.trim());

  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length >= 4) {
      commits.push({
        hash: lines[0],
        shortHash: lines[1],
        date: lines[2],
        message: lines[3],
      });
    }
  }

  return commits;
}

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition, ToolProvider } from "./types.js";
import type { PluginClient } from "../integrations/plugin-client.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Tools that proxy to the obsidi-mcp desktop plugin for features
 * that require the Obsidian runtime (semantic search, graph, Dataview).
 */
export class PluginToolProvider implements ToolProvider {
  id = "plugin";
  name = "Plugin Tools (obsidi-mcp proxy)";

  constructor(private client: PluginClient) {}

  getTools(): ToolDefinition[] {
    return [
      this.semanticSearch(),
      this.backlinks(),
      this.graphNeighbors(),
      this.dataviewQuery(),
    ];
  }

  private proxyTool(
    name: string,
    description: string,
    inputSchema: z.ZodObject<z.ZodRawShape>,
    pluginToolName: string,
  ): ToolDefinition {
    return {
      name,
      description: `${description} (requires obsidi-mcp plugin)`,
      inputSchema,
      handler: async (params) => {
        try {
          const healthy = await this.client.isHealthy();
          if (!healthy) {
            return textResult(
              `The obsidi-mcp plugin is not available. This tool requires Obsidian to be running ` +
                `with the obsidi-mcp plugin active. The core vault tools (read_note, search_content, etc.) ` +
                `work without the plugin.`,
            );
          }
          const result = await this.client.callTool(pluginToolName, params);
          return textResult(result);
        } catch (err) {
          return textResult(
            `Plugin proxy error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    };
  }

  private semanticSearch(): ToolDefinition {
    return this.proxyTool(
      "semantic_search",
      "AI-powered semantic search across vault notes using RAG embeddings",
      z.object({
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().describe("Max results (default: 10)"),
      }),
      "semantic_search",
    );
  }

  private backlinks(): ToolDefinition {
    return this.proxyTool(
      "backlinks",
      "Get all notes that link TO a specific note",
      z.object({
        path: z.string().describe("Vault-relative path to find backlinks for"),
      }),
      "backlinks",
    );
  }

  private graphNeighbors(): ToolDefinition {
    return this.proxyTool(
      "graph_neighbors",
      "Get directly connected notes in the knowledge graph (bidirectional links)",
      z.object({
        path: z.string().describe("Vault-relative path to find neighbors for"),
        depth: z.number().optional().describe("Traversal depth (default: 1)"),
      }),
      "graph_neighbors",
    );
  }

  private dataviewQuery(): ToolDefinition {
    return this.proxyTool(
      "run_dataview_query",
      "Execute a Dataview Query Language (DQL) query against the vault",
      z.object({
        query: z.string().describe("DQL query string"),
      }),
      "run_dataview_query",
    );
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { ToolRegistry } from "./tools/index.js";
import { logger } from "./logger.js";

export function createMcpApp(registry: ToolRegistry, mcpPath: string) {
  const app = express();
  app.use(express.json());

  app.post(mcpPath, async (req, res) => {
    const server = createServer(registry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return { app };
}

function createServer(registry: ToolRegistry): McpServer {
  const server = new McpServer({
    name: "obaass-mcp",
    version: "0.1.0",
  });

  for (const tool of registry.getAllTools()) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      async (params) => {
        try {
          return await tool.handler(params as Record<string, unknown>);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Tool '${tool.name}' failed`, { error: message });
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

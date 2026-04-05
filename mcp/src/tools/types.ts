import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (params: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface ToolProvider {
  id: string;
  name: string;
  getTools(): ToolDefinition[];
}

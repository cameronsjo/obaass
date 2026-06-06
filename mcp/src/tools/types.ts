import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

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

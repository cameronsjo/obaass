import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: z.ZodObject;
	outputSchema?: z.ZodObject;
	handler: (params: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface ToolProvider {
	id: string;
	name: string;
	getTools(): ToolDefinition[];
}

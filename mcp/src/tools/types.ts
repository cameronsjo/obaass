import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: z.ZodObject;
	outputSchema?: z.ZodObject;
	/**
	 * True when the tool never changes vault or external state. Unmarked tools
	 * count as writes and are withheld in read-only mode.
	 */
	readOnly?: true;
	handler: (params: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface ToolProvider {
	id: string;
	name: string;
	getTools(): ToolDefinition[];
}

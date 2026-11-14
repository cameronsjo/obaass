import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Access } from "./tiers.js";

/** Per-call context the server passes to every handler. */
export interface ToolContext {
	/** The caller's access; handlers that touch the vault pick their view from it. */
	access: Access;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: z.ZodObject;
	outputSchema?: z.ZodObject;
	/**
	 * True when the tool never changes vault or external state (sent to clients
	 * as `readOnlyHint`). Access tiers do not read this flag; they are allowlists
	 * in `tiers.ts`.
	 */
	readOnly?: true;
	handler: (
		params: Record<string, unknown>,
		ctx: ToolContext,
	) => Promise<CallToolResult>;
}

export interface ToolProvider {
	id: string;
	name: string;
	getTools(): ToolDefinition[];
}

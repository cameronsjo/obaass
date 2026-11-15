import { type Access, toolAllowed } from "./tiers.js";
import type { ToolDefinition, ToolProvider } from "./types.js";

export class ToolRegistry {
	private providers: ToolProvider[] = [];

	register(provider: ToolProvider): void {
		this.providers.push(provider);
	}

	getAllTools(): ToolDefinition[] {
		return this.providers.flatMap((p) => p.getTools());
	}

	/**
	 * Tools to serve for `access` — the single enforcement point for tiers. An
	 * undefined access (no valid tier) serves nothing.
	 */
	getServedTools(access: Access | undefined): ToolDefinition[] {
		return this.getAllTools().filter((tool) => toolAllowed(access, tool.name));
	}

	/** Every registered tool name, for logging only names that exist. */
	getToolNames(): ReadonlySet<string> {
		return new Set(this.getAllTools().map((tool) => tool.name));
	}

	findTool(name: string): ToolDefinition | undefined {
		for (const provider of this.providers) {
			const tool = provider.getTools().find((t) => t.name === name);
			if (tool) return tool;
		}
		return undefined;
	}

	getProviderIds(): string[] {
		return this.providers.map((p) => p.id);
	}
}

export type { ToolDefinition, ToolProvider } from "./types.js";

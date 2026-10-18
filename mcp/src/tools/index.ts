import type { ToolDefinition, ToolProvider } from "./types.js";

export class ToolRegistry {
	private providers: ToolProvider[] = [];

	register(provider: ToolProvider): void {
		this.providers.push(provider);
	}

	getAllTools(): ToolDefinition[] {
		return this.providers.flatMap((p) => p.getTools());
	}

	/** Tools to serve; read-only mode withholds every tool not marked `readOnly`. */
	getServedTools(readOnly: boolean): ToolDefinition[] {
		return this.getAllTools().filter((tool) => !readOnly || tool.readOnly);
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

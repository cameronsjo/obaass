import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginClient } from "../src/integrations/plugin-client.js";
import { installShutdownHandlers } from "../src/shutdown.js";

describe("graceful shutdown", () => {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(process, "on").mockImplementation((event, listener) => {
			handlers.set(event, listener);
			return process;
		});
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	});
	afterEach(() => {
		handlers.clear();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("waits for MCP and plugin cleanup even when HTTP closes first", async () => {
		let finishMcp = () => {};
		let finishPlugin = () => {};
		const mcpClose = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishMcp = resolve;
				}),
		);
		const disconnect = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishPlugin = resolve;
				}),
		);
		let httpClosed: (() => Promise<void>) | undefined;
		const close = vi.fn((callback: () => Promise<void>) => {
			httpClosed = callback;
		});
		installShutdownHandlers(
			{ close } as unknown as Server,
			{ disconnect } as unknown as PluginClient,
			mcpClose,
		);
		handlers.get("SIGTERM")?.();
		handlers.get("SIGINT")?.();
		expect(close).toHaveBeenCalledOnce();
		expect(mcpClose).toHaveBeenCalledOnce();
		const completion = httpClosed?.();
		await Promise.resolve();
		expect(process.exit).not.toHaveBeenCalled();
		expect(disconnect).not.toHaveBeenCalled();
		finishMcp();
		await Promise.resolve();
		await Promise.resolve();
		expect(disconnect).toHaveBeenCalledOnce();
		expect(process.exit).not.toHaveBeenCalled();
		finishPlugin();
		await completion;
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("logs failed cleanup and retains the bounded forced-exit path", async () => {
		let httpClosed: (() => Promise<void>) | undefined;
		const close = (callback: () => Promise<void>) => {
			httpClosed = callback;
		};
		const disconnect = vi.fn(async () => {
			throw new Error("plugin failed");
		});
		installShutdownHandlers(
			{ close } as unknown as Server,
			{ disconnect } as unknown as PluginClient,
			async () => {
				throw new Error("MCP failed");
			},
		);
		handlers.get("SIGTERM")?.();
		await httpClosed?.();
		expect(disconnect).toHaveBeenCalledOnce();
		expect(process.exit).toHaveBeenCalledWith(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(process.exit).toHaveBeenCalledWith(1);
		handlers.get("unhandledRejection")?.(new Error("rejected"));
		handlers.get("uncaughtException")?.(new Error("uncaught"));
	});
});

/**
 * Access tiers — a SECURITY BOUNDARY that fails closed.
 *
 * A bearer token selects a tier; the tier selects which tools a request's
 * server registers. A tool outside the tier is never registered, so the SDK
 * answers it as an unknown tool. Every non-`full` tier is a literal allowlist:
 * a tool added later is outside it until someone adds its name here.
 *
 * Never wrap `toolAllowed` or `resolveAccess` in a catch that grants access, and
 * never derive a tier from request headers, `ctx.requestInfo`, or `readOnly`
 * flags. An unknown or missing tier means no tools.
 */
import { createHash } from "node:crypto";
import { logger } from "../logger.js";

/** Tiers a bearer token can select. */
export const TIERS = ["full", "limited"] as const;
export type Tier = (typeof TIERS)[number];

/** What a request may do: a token tier, or the unauthenticated opt-out. */
export type Access = Tier | "anonymous";

/** One configured token per tier; an absent tier has no credential. */
export interface TierTokens {
	full?: string | undefined;
	limited?: string | undefined;
}

const READ_TOOLS = [
	"read_note",
	"search_content",
	"vault_structure",
	"file_metadata",
	"vault_tags",
	"search_by_tag",
	"search_by_property",
	"recent_files",
	"get_instructions",
] as const;

/** Tools the unauthenticated opt-out serves. */
export const ANONYMOUS_TOOLS: ReadonlySet<string> = new Set(READ_TOOLS);

/** Tools the `limited` tier serves: read, search, create, append. */
export const LIMITED_TOOLS: ReadonlySet<string> = new Set([
	...READ_TOOLS,
	"create_note",
	"append_to_note",
	"daily_note",
]);

export function isTier(value: unknown): value is Tier {
	return (
		typeof value === "string" && (TIERS as readonly string[]).includes(value)
	);
}

export function hasTokens(tokens: TierTokens): boolean {
	return !!(tokens.full || tokens.limited);
}

/** True only when `access` is a known value whose allowlist names the tool. */
export function toolAllowed(
	access: Access | undefined,
	toolName: string,
): boolean {
	switch (access) {
		case "full":
			return true;
		case "limited":
			return LIMITED_TOOLS.has(toolName);
		case "anonymous":
			return ANONYMOUS_TOOLS.has(toolName);
		default:
			return false;
	}
}

export interface AccessOptions {
	tokens: TierTokens;
	/** MCP_ALLOW_UNAUTHENTICATED: serve the anonymous set when no token is configured. */
	anonymous?: boolean | undefined;
}

/**
 * The mode table. With any token configured, access comes only from the
 * `clientId` the bearer middleware set, and only for a tier that has a token;
 * anything else is `undefined` (no tools). With no token configured, access is
 * the deployment's mode: `anonymous` under the opt-out, else `full` (loopback).
 */
export function resolveAccess(
	options: AccessOptions,
	authInfo: { clientId?: unknown } | undefined,
): Access | undefined {
	if (hasTokens(options.tokens)) {
		const clientId = authInfo?.clientId;
		return isTier(clientId) && options.tokens[clientId] ? clientId : undefined;
	}
	return options.anonymous ? "anonymous" : "full";
}

const FINGERPRINT_DOMAIN = "obaass-mcp:token-fp:v1:";
const FINGERPRINT_HEX_CHARS = 8;

/**
 * A short, domain-separated digest per configured token, for confirming which
 * token a running server loaded. Logged at startup only.
 */
export function tokenFingerprints(
	tokens: TierTokens,
): Array<{ tier: Tier; fingerprint: string }> {
	return TIERS.flatMap((tier) => {
		const token = tokens[tier];
		if (!token) return [];
		const fingerprint = createHash("sha256")
			.update(FINGERPRINT_DOMAIN + token)
			.digest("hex")
			.slice(0, FINGERPRINT_HEX_CHARS);
		return [{ tier, fingerprint }];
	});
}

/** Why a request was refused; a fixed set so log keys stay finite. */
export type RefusalKind =
	| "out_of_tier"
	| "dot_segment"
	| "non_md"
	| "symlink"
	| "outside_root"
	| "instruction_file"
	| "protected_path"
	| "write_scope"
	| "write_operation"
	| "overwrite"
	| "regex"
	| "rate_limited";

const REFUSAL_WINDOW_MS = 60_000;

interface RefusalWindow {
	start: number;
	suppressed: number;
	/** Request id of the refusal that opened the window, carried on its count line. */
	firstRequestId: string;
}

/**
 * Refusal audit trail. The first refusal for a `(tier, tool, kind)` key in a
 * window logs at once; later ones only count, and `flush()` reports the count.
 * Tool names are logged only when registered; anything else is `unknown` plus
 * its length, so a caller cannot write arbitrary text into the log. A refusal
 * that is not about one tool (a rate limit) logs `tool: "all"`.
 */
export class RefusalLog {
	private windows = new Map<string, RefusalWindow & { fields: object }>();

	constructor(
		private readonly registeredTools: ReadonlySet<string>,
		private readonly now: () => number = Date.now,
	) {}

	/** `toolName` is undefined for refusals that are not about one tool (rate limits). */
	record(
		tier: Access | "none",
		toolName: string | undefined,
		refusalKind: RefusalKind,
		requestId: string,
	): void {
		const known = toolName === undefined || this.registeredTools.has(toolName);
		const tool = toolName === undefined ? "all" : known ? toolName : "unknown";
		const fields = {
			tier,
			tool,
			...(!known && { toolNameLength: toolName?.length ?? 0 }),
			refusalKind,
		};
		const key = `${tier}\u0000${tool}\u0000${refusalKind}`;
		const window = this.windows.get(key);
		const now = this.now();
		if (window && now - window.start < REFUSAL_WINDOW_MS) {
			window.suppressed++;
			return;
		}
		if (window) this.emitCount(window);
		this.windows.set(key, {
			start: now,
			suppressed: 0,
			firstRequestId: requestId,
			fields,
		});
		logger.warn("Refused MCP request outside its access tier", {
			...fields,
			requestId,
		});
	}

	/** Report and clear counts for windows that have ended. */
	flush(): void {
		const now = this.now();
		for (const [key, window] of this.windows) {
			if (now - window.start < REFUSAL_WINDOW_MS) continue;
			this.emitCount(window);
			this.windows.delete(key);
		}
	}

	private emitCount(window: RefusalWindow & { fields: object }): void {
		if (window.suppressed === 0) return;
		logger.warn("Repeated refusals outside access tier", {
			...window.fields,
			count: window.suppressed,
			firstRequestId: window.firstRequestId,
			windowMs: REFUSAL_WINDOW_MS,
		});
	}
}

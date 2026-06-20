import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

export interface ParsedNote {
	frontmatter: Record<string, unknown> | null;
	content: string;
	raw: string;
}

/** Parse a markdown note into frontmatter and content. */
export function parseNote(raw: string): ParsedNote {
	const match = raw.match(FRONTMATTER_REGEX);
	if (!match) {
		return { frontmatter: null, content: raw, raw };
	}

	try {
		const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
		const content = raw.slice(match[0].length).replace(/^\r?\n/, "");
		return { frontmatter, content, raw };
	} catch {
		// Malformed YAML — treat the whole file as content
		return { frontmatter: null, content: raw, raw };
	}
}

/** Serialize frontmatter and content back into a markdown string. */
export function serializeNote(
	frontmatter: Record<string, unknown> | null,
	content: string,
): string {
	if (!frontmatter || Object.keys(frontmatter).length === 0) {
		return content;
	}
	const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
	return `---\n${yaml}\n---\n${content}`;
}

/** Update specific frontmatter properties, preserving the rest. */
export function updateFrontmatter(
	raw: string,
	updates: Record<string, unknown>,
): string {
	const { frontmatter, content } = parseNote(raw);
	const merged = { ...(frontmatter ?? {}), ...updates };
	return serializeNote(merged, content);
}

/** Extract tags from frontmatter and inline content. */
export function extractTags(raw: string): string[] {
	const { frontmatter, content } = parseNote(raw);
	const tags = new Set<string>();

	// Frontmatter tags (string or array)
	if (frontmatter?.tags) {
		const fmTags = Array.isArray(frontmatter.tags)
			? frontmatter.tags
			: [frontmatter.tags];
		for (const t of fmTags) {
			if (typeof t === "string") tags.add(t.replace(/^#/, ""));
		}
	}

	// Inline tags: #tag (not inside code blocks or links)
	const inlineTagRegex = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;
	for (
		let match = inlineTagRegex.exec(content);
		match !== null;
		match = inlineTagRegex.exec(content)
	) {
		tags.add(match[1]);
	}

	return [...tags];
}

/** Extract headings from markdown content. */
export function extractHeadings(
	content: string,
): Array<{ level: number; text: string }> {
	const headings: Array<{ level: number; text: string }> = [];
	const regex = /^(#{1,6})\s+(.+)$/gm;
	for (
		let match = regex.exec(content);
		match !== null;
		match = regex.exec(content)
	) {
		headings.push({ level: match[1].length, text: match[2].trim() });
	}
	return headings;
}

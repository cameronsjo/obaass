import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractHeadings,
	extractTags,
	parseNote,
	serializeNote,
	updateFrontmatter,
} from "../../src/vault/frontmatter.js";

describe("parseNote", () => {
	it("parses a note with valid YAML frontmatter", () => {
		// The closing '---' newline is stripped but the blank line after it is not —
		// replace(/^\r?\n/, '') removes exactly one newline.
		const raw =
			"---\ntitle: My Note\nstatus: draft\n---\n# Heading\n\nbody text";
		const result = parseNote(raw);
		expect(result.raw).toBe(raw);
		expect(result.frontmatter).toEqual({ title: "My Note", status: "draft" });
		expect(result.content).toBe("# Heading\n\nbody text");
	});

	it("returns frontmatter null when there is no frontmatter block", () => {
		const raw = "# Just a heading\n\nbody";
		const result = parseNote(raw);
		expect(result.frontmatter).toBeNull();
		expect(result.content).toBe(raw);
		expect(result.raw).toBe(raw);
	});

	it("returns frontmatter null and content===raw for malformed YAML (no throw)", () => {
		const raw = "---\n: : bad yaml\n---\n\nbody";
		// must not throw
		const result = parseNote(raw);
		expect(result.frontmatter).toBeNull();
		expect(result.content).toBe(raw);
	});

	it("handles CRLF frontmatter delimiters", () => {
		const raw = "---\r\nkey: value\r\n---\r\ncontent after";
		const result = parseNote(raw);
		expect(result.frontmatter).not.toBeNull();
		expect(result.frontmatter?.key).toBe("value");
		// Content should contain 'content after'
		expect(result.content).toContain("content after");
	});

	it("returns empty content string when frontmatter block is followed by nothing", () => {
		const raw = "---\nkey: v\n---\n";
		const result = parseNote(raw);
		expect(result.frontmatter).toEqual({ key: "v" });
		expect(result.content).toBe("");
	});

	it("does not interpret a lone --- not at the start as frontmatter", () => {
		const raw = "body\n---\nnot frontmatter\n---\n";
		const result = parseNote(raw);
		expect(result.frontmatter).toBeNull();
		expect(result.content).toBe(raw);
	});
});

describe("serializeNote", () => {
	it("round-trips: serialize then parse reproduces frontmatter and content", () => {
		const fm = { title: "Test", status: "done", count: 3 };
		const content = "body line 1\nbody line 2";
		const serialized = serializeNote(fm, content);
		expect(serialized).toContain("---");
		const reparsed = parseNote(serialized);
		expect(reparsed.frontmatter).toMatchObject(fm);
		expect(reparsed.content).toBe(content);
	});

	it("returns content unchanged when frontmatter is null", () => {
		const content = "just body text";
		expect(serializeNote(null, content)).toBe(content);
	});

	it("returns content unchanged when frontmatter is an empty object", () => {
		const content = "just body text";
		expect(serializeNote({}, content)).toBe(content);
	});

	it("produces a valid YAML block with --- delimiters", () => {
		const result = serializeNote({ x: 1 }, "body");
		expect(result).toMatch(/^---\n/);
		expect(result).toContain("\n---\n");
		expect(result).toContain("body");
	});
});

describe("updateFrontmatter", () => {
	it("adds new keys while preserving existing ones", () => {
		const raw = "---\nstatus: draft\n---\n\nbody";
		const updated = updateFrontmatter(raw, { priority: "high" });
		const { frontmatter } = parseNote(updated);
		expect(frontmatter?.status).toBe("draft");
		expect(frontmatter?.priority).toBe("high");
	});

	it("overwrites an existing key with the new value", () => {
		const raw = "---\nstatus: draft\n---\n\nbody";
		const updated = updateFrontmatter(raw, { status: "done" });
		const { frontmatter } = parseNote(updated);
		expect(frontmatter?.status).toBe("done");
	});

	it("creates frontmatter when none exists", () => {
		const raw = "body with no frontmatter";
		const updated = updateFrontmatter(raw, { status: "new" });
		const { frontmatter, content } = parseNote(updated);
		expect(frontmatter?.status).toBe("new");
		expect(content).toContain("body with no frontmatter");
	});

	it("preserves the body content (content starts after the single post-delimiter newline)", () => {
		// serializeNote writes "---\n{yaml}\n---\n{content}", so parsing the result
		// strips one leading newline from content. Use a single-newline separator
		// so the round-trip is lossless.
		const raw = "---\nk: v\n---\noriginal body";
		const updated = updateFrontmatter(raw, { extra: true });
		expect(parseNote(updated).content).toBe("original body");
	});
});

describe("extractTags", () => {
	it("extracts frontmatter tags in array form", () => {
		const raw = "---\ntags: [alpha, beta, gamma]\n---\nbody";
		const tags = extractTags(raw);
		expect(tags).toContain("alpha");
		expect(tags).toContain("beta");
		expect(tags).toContain("gamma");
	});

	it("extracts frontmatter tags in string (scalar) form", () => {
		const raw = "---\ntags: single-tag\n---\nbody";
		const tags = extractTags(raw);
		expect(tags).toContain("single-tag");
	});

	it("strips leading # from frontmatter tags", () => {
		const raw = "---\ntags: ['#hashprefixed']\n---\nbody";
		const tags = extractTags(raw);
		expect(tags).toContain("hashprefixed");
		expect(tags).not.toContain("#hashprefixed");
	});

	it("extracts inline #tags from content", () => {
		const raw = "---\ntitle: test\n---\nsome text with #inline and #another";
		const tags = extractTags(raw);
		expect(tags).toContain("inline");
		expect(tags).toContain("another");
	});

	it("deduplicates tags that appear in both frontmatter and content", () => {
		const raw = "---\ntags: [shared]\n---\ntext with #shared inline";
		const tags = extractTags(raw);
		expect(tags.filter((t) => t === "shared").length).toBe(1);
	});

	it("does not extract headings as tags", () => {
		const raw = "---\ntitle: t\n---\n## Section Heading\n#actualTag text";
		const tags = extractTags(raw);
		// Headings use `## ` (space after hashes), not `#letter` — should not appear
		expect(tags).not.toContain("Section");
		expect(tags).not.toContain("#");
		expect(tags).toContain("actualTag");
	});

	it("returns empty array when there are no tags", () => {
		const raw = "no frontmatter, no inline tags";
		expect(extractTags(raw)).toEqual([]);
	});
});

describe("extractHeadings", () => {
	it("extracts all heading levels 1 through 6", () => {
		const content = [
			"# H1",
			"## H2",
			"### H3",
			"#### H4",
			"##### H5",
			"###### H6",
		].join("\n");
		const headings = extractHeadings(content);
		expect(headings).toEqual([
			{ level: 1, text: "H1" },
			{ level: 2, text: "H2" },
			{ level: 3, text: "H3" },
			{ level: 4, text: "H4" },
			{ level: 5, text: "H5" },
			{ level: 6, text: "H6" },
		]);
	});

	it("trims trailing whitespace from heading text", () => {
		const content = "#  Heading with spaces  ";
		const headings = extractHeadings(content);
		expect(headings[0].text).toBe("Heading with spaces");
	});

	it("returns empty array when there are no headings", () => {
		expect(extractHeadings("just plain text")).toEqual([]);
	});

	it("does not match headings lacking a space after the hashes", () => {
		const content = "#nospace should not match\n# space matches";
		const headings = extractHeadings(content);
		expect(headings.length).toBe(1);
		expect(headings[0].text).toBe("space matches");
	});
});

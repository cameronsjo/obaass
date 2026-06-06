import { describe, expect, it } from "vitest";
import {
	extractWikilinks,
	rewriteWikilinks,
} from "../../src/vault/wikilink.js";

describe("extractWikilinks", () => {
	it("extracts a plain wikilink", () => {
		const links = extractWikilinks("see [[my note]] for details");
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			full: "[[my note]]",
			path: "my note",
			alias: undefined,
			heading: undefined,
		});
	});

	it("extracts an aliased wikilink", () => {
		const links = extractWikilinks("[[the note|display text]]");
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			path: "the note",
			alias: "display text",
			heading: undefined,
		});
	});

	it("extracts a wikilink with a heading anchor", () => {
		const links = extractWikilinks("[[note#section]]");
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			path: "note",
			alias: undefined,
			heading: "section",
		});
	});

	it("extracts a combined folder/path + heading + alias wikilink", () => {
		const links = extractWikilinks("[[folder/note#heading|alias]]");
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			full: "[[folder/note#heading|alias]]",
			path: "folder/note",
			heading: "heading",
			alias: "alias",
		});
	});

	it("extracts multiple wikilinks from a single string", () => {
		const links = extractWikilinks("start [[a]] middle [[b|B]] end [[c#h]]");
		expect(links).toHaveLength(3);
		expect(links.map((l) => l.path)).toEqual(["a", "b", "c"]);
	});

	it("returns an empty array when there are no wikilinks", () => {
		expect(extractWikilinks("plain text with no links")).toHaveLength(0);
	});

	it("is safe to call multiple times on different inputs (no lastIndex leakage)", () => {
		// Global regexes retain lastIndex; calling on content with links then again
		// on content without must still find links.
		extractWikilinks("[[first]]");
		const links = extractWikilinks("[[second]]");
		expect(links).toHaveLength(1);
		expect(links[0].path).toBe("second");
	});
});

describe("rewriteWikilinks", () => {
	it("rewrites a plain wikilink by exact name", () => {
		const out = rewriteWikilinks("see [[note]] here", "note", "renamed");
		expect(out).toBe("see [[renamed]] here");
	});

	it("rewrites using basename when old name contains a folder path", () => {
		// 'folder/note' has basename 'note'; a link [[note]] should match
		const out = rewriteWikilinks(
			"see [[note]] here",
			"folder/note",
			"folder/renamed",
		);
		expect(out).toBe("see [[folder/renamed]] here");
	});

	it("strips .md extension from old and new names for comparison", () => {
		// Link written as [[note]] (no .md); rename from 'note.md' to 'renamed.md'
		const out = rewriteWikilinks("[[note]]", "note.md", "renamed.md");
		expect(out).toBe("[[renamed]]");
	});

	it("preserves alias when rewriting", () => {
		const out = rewriteWikilinks("[[note|My Label]]", "note", "renamed");
		expect(out).toBe("[[renamed|My Label]]");
	});

	it("preserves heading anchor when rewriting", () => {
		const out = rewriteWikilinks("[[note#section]]", "note", "renamed");
		expect(out).toBe("[[renamed#section]]");
	});

	it("preserves both heading and alias together", () => {
		const out = rewriteWikilinks("[[note#section|label]]", "note", "renamed");
		expect(out).toBe("[[renamed#section|label]]");
	});

	it("does NOT rewrite a partial name match: [[note-two]] is not [[note]]", () => {
		const out = rewriteWikilinks("see [[note-two]] here", "note", "renamed");
		expect(out).toBe("see [[note-two]] here");
	});

	it("does NOT rewrite an unrelated link", () => {
		const out = rewriteWikilinks("[[other]] and [[note]]", "note", "renamed");
		expect(out).toBe("[[other]] and [[renamed]]");
	});

	it("rewrites all occurrences of the same link in one pass", () => {
		const out = rewriteWikilinks(
			"[[note]] then [[note]] again",
			"note",
			"renamed",
		);
		expect(out).toBe("[[renamed]] then [[renamed]] again");
	});

	it("is safe to call multiple times (no lastIndex leakage)", () => {
		rewriteWikilinks("[[a]] [[b]]", "a", "x");
		const out = rewriteWikilinks("[[a]] [[b]]", "b", "y");
		expect(out).toBe("[[a]] [[y]]");
	});
});

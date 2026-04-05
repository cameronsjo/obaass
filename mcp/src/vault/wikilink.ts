/**
 * Wikilink parsing and cross-vault rename support.
 *
 * Handles patterns: [[note]], [[note|alias]], [[folder/note]],
 * [[note#heading]], [[note#heading|alias]]
 */

export interface Wikilink {
  /** Full match including brackets: [[path|alias]] */
  full: string;
  /** Target path without alias or heading: "folder/note" */
  path: string;
  /** Display alias if present */
  alias?: string;
  /** Heading anchor if present */
  heading?: string;
}

const WIKILINK_REGEX = /\[\[([^\]]+?)\]\]/g;

/** Extract all wikilinks from markdown content. */
export function extractWikilinks(content: string): Wikilink[] {
  const links: Wikilink[] = [];
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    const inner = match[1];
    const full = match[0];

    // Split alias: [[path|alias]]
    const pipeIndex = inner.indexOf("|");
    const beforeAlias = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
    const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : undefined;

    // Split heading: [[path#heading]]
    const hashIndex = beforeAlias.indexOf("#");
    const path = hashIndex >= 0 ? beforeAlias.slice(0, hashIndex) : beforeAlias;
    const heading = hashIndex >= 0 ? beforeAlias.slice(hashIndex + 1) : undefined;

    links.push({ full, path: path.trim(), alias, heading });
  }

  return links;
}

/**
 * Rewrite wikilinks in content when a file is renamed.
 * Updates [[oldName]] to [[newName]] while preserving aliases and headings.
 */
export function rewriteWikilinks(
  content: string,
  oldName: string,
  newName: string,
): string {
  // Normalize: strip .md extension for comparison
  const oldNorm = oldName.replace(/\.md$/, "");
  const newNorm = newName.replace(/\.md$/, "");

  return content.replace(WIKILINK_REGEX, (full, inner: string) => {
    const pipeIndex = inner.indexOf("|");
    const beforeAlias = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
    const aliasPart = pipeIndex >= 0 ? `|${inner.slice(pipeIndex + 1)}` : "";

    const hashIndex = beforeAlias.indexOf("#");
    const path = hashIndex >= 0 ? beforeAlias.slice(0, hashIndex) : beforeAlias;
    const headingPart = hashIndex >= 0 ? `#${beforeAlias.slice(hashIndex + 1)}` : "";

    const trimmedPath = path.trim();

    // Match by full path or just the filename part (Obsidian resolves shortest unique)
    const oldBasename = oldNorm.split("/").pop() ?? oldNorm;
    if (trimmedPath === oldNorm || trimmedPath === oldBasename) {
      return `[[${newNorm}${headingPart}${aliasPart}]]`;
    }

    return full;
  });
}

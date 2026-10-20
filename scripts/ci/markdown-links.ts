// The Markdown link parser behind the hard rules' link rule (scripts/ci/hard-rules.ts): the
// relative links a Markdown text holds, outside fenced and inline code and HTML comments, and the
// repository path each one names. See docs/agents/git-hooks/hard-rules.md.
import { dirname, posix } from "node:path";

// Inline links, whose destination may hold balanced parentheses, and reference definitions
// (`[label]: path`, not a `[^note]:` footnote).
const LINK =
  /(?<!\\)\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE =
  /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>\n]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
// A fence may sit in a list item (any indentation) or a block quote (after its `>` markers). A
// backtick fence's info string holds no backtick (CommonMark), so ```bash``` is inline code.
const FENCE = /^[\s>]*(`{3,}(?=[^`]*$)|~{3,})/;

function withoutInlineCode(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    const open = /`+/g;
    open.lastIndex = index;
    const opener = open.exec(line);
    if (!opener) break;
    result += line.slice(index, opener.index);
    const close = new RegExp(`(?<!\`)${opener[0]}(?!\`)`, "g");
    close.lastIndex = opener.index + opener[0].length;
    const closer = close.exec(line);
    // An unmatched run is literal text.
    if (!closer) return result + line.slice(opener.index);
    index = closer.index + closer[0].length;
  }
  return result + line.slice(index);
}

/** The link targets of a Markdown text, outside fenced and inline code and HTML comments, with
 * 1-based lines. */
export function markdownLinks(text: string): { line: number; target: string }[] {
  const links: { line: number; target: string }[] = [];
  let fence: string | undefined;
  let comment = false;
  text.split("\n").forEach((source, index) => {
    let raw = source;
    if (comment) {
      const end = raw.indexOf("-->");
      if (end === -1) return;
      raw = raw.slice(end + 3);
      comment = false;
    }
    const marker = FENCE.exec(raw)?.[1];
    if (fence) {
      const closes =
        marker?.[0] === fence[0] &&
        marker.length >= fence.length &&
        raw.replace(/^[\s>]*/, "").trim() === marker;
      if (closes) fence = undefined;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    let line = withoutInlineCode(raw).replace(/<!--[\s\S]*?-->/g, "");
    // An unclosed comment opens a block only at the start of a line (CommonMark); mid-line, the
    // marker is literal text.
    if (/^ {0,3}<!--/.test(line)) {
      line = "";
      comment = true;
    }
    const targets = [...line.matchAll(LINK)].map((match) => match[1]!);
    const reference = REFERENCE.exec(line)?.[1];
    if (reference) targets.push(reference);
    for (const target of targets)
      links.push({ line: index + 1, target: target.replace(/^<|>$/g, "") });
  });
  return links;
}

/** The repository path a link in `from` names, or undefined when it is not a relative link (a
 * URL with a scheme, `mailto:`, a pure anchor). A path outside the repository starts with `../`. */
export function linkPath(from: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#"))
    return undefined;
  let path = target.replace(/[#?].*$/, "");
  if (path === "") return undefined;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded: the text is the path.
  }
  const joined = path.startsWith("/") ? path.slice(1) : posix.join(dirname(from), path);
  return posix.normalize(joined || ".").replace(/\/+$/, "") || ".";
}

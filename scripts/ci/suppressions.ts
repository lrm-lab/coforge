import { MARKDOWN } from "./markdown-links";

// The new-suppression rule's line matcher (scripts/ci/hard-rules.ts, rule 11). The token alternatives end in a character class so that this file's
// own lines carry none of the tokens. A directive counts after a comment opener, or, in a file with
// block comments, at the start of a line (after any `*`), where a comment opened earlier holds it.
const DIRECTIVE = String.raw`((?:oxlint-disabl[e]|eslint-disabl[e]|biome-ignor[e]|@ts-(?:ignor[e]|expect-erro[r]|nochec[k])).*)`;
const MARKED_DIRECTIVE = new RegExp(String.raw`(?:\/\/+|\/\*+|<!--)\s*${DIRECTIVE}`);
const LINE_START_DIRECTIVE = new RegExp(String.raw`^\s*\**\s*${DIRECTIVE}`);
const BLOCK_COMMENT_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less|rs)$/;
const SKIPPED_TEST = /\.(?:skip|only)(?:\.each)?\s*[(`]/;
const RUST_ALLOW = /#!?\[(?:allow|expec[t])\(.*/;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE =
  /(?:\.(?:test|spec|e2e|integration)\.|_(?:test|spec)_)|(?:^|\/)(?:tests?|__tests__)\//;

/** The suppression a line of `path` carries, or undefined; Markdown may name them. It is the
 * directive through the end of the line, or a test call's `.skip(` alone: a line edited around it
 * (a renamed skipped test, a changed dependency list) keeps the same suppression. */
export function suppressionIn(path: string, line: string): string | undefined {
  if (MARKDOWN.test(path)) return undefined;
  const skipped = SCRIPT_FILE.test(path) && TEST_FILE.test(path) && SKIPPED_TEST.exec(line);
  const found =
    MARKED_DIRECTIVE.exec(line)?.[1] ??
    (BLOCK_COMMENT_FILE.test(path) ? LINE_START_DIRECTIVE.exec(line)?.[1] : undefined) ??
    (path.endsWith(".rs") ? RUST_ALLOW.exec(line)?.[0] : undefined) ??
    (skipped ? skipped[0].replace(/\s/g, "") : undefined);
  return found?.trim();
}

// The hard rules: repository rules a machine enforces, with no allowlist and no inline override.
// `.githooks/pre-commit` runs them on the commit being made (`--staged`); CI's Plan checks job runs
// them over the pushed or proposed range (`--range`; a base that is not a commit skips them with a
// warning). The one exemption: files under a skill directory registered in skills-lock.json are
// vendored, and the file rules (size, Markdown length and links, suppressions) skip them.
// See docs/agents/git-hooks/hard-rules.md.
//
// usage: bun scripts/ci/hard-rules.ts --staged | --all
//        bun scripts/ci/hard-rules.ts --range <base> <head> [--authors-since <rev>]...
//   --authors-since: a push checks the authors of only the commits it introduced (`<rev>..<head>`;
//   given more than once, those reachable from none of the revs), so a pushed bot commit fails one
//   run, not every run until main is rewritten; revs that are not commits fall back to the range.
//   --all checks every Markdown file's length and links in HEAD, and every author in its history.
//   Exit 1 lists violations on stderr.
import { dirname } from "node:path";
import {
  type ChangeSource,
  describeViolation,
  diffArgs,
  git,
  policyRevision,
  SIZE_FIX,
  sizeViolations,
} from "../git-hooks/staged-file-size";
import { commitIdentities, type IdentityMatch, stagedIdentities } from "./commit-identity";
import { linkPath, markdownLinks } from "./markdown-links";
import { unquote } from "./unquote";
import { MIGRATION_SAFETY_FIX, migrationSafetyViolations } from "../migration-safety/hard-rule";

type Rule =
  | "size-ratchet"
  | "markdown-lines"
  | "markdown-links"
  | "new-suppression"
  | "author-identity"
  | "migration-safety";
type Violation = { rule: Rule; location: string; found: string };

const FIX: Record<Rule, string> = {
  "size-ratchet": SIZE_FIX,
  "markdown-lines":
    "Split the document into a topic directory: keep a short README.md overview that links to focused Markdown files, move each section into its owning file, and update incoming links.",
  "markdown-links":
    "Point each link at a file or directory tracked in the change (relative to the Markdown file; a leading / is the repository root), or remove the link.",
  "new-suppression":
    "Fix the underlying code instead. A new lint, type-check or test exemption needs the user's explicit prior approval (AGENTS.md, Decision gates); this check has no inline override.",
  "author-identity":
    "Commit as the person running the Agent, never as an Agent or bot (AGENTS.md); author and committer both count: set `git config user.name` and `git config user.email` to their own identity. Rewrite a listed commit not yet on main with `git rebase --exec 'git commit --amend --no-edit --reset-author' <base>`; one already on main is rewritten only when Frank asks. A Co-authored-by trailer is not checked.",
  "migration-safety": MIGRATION_SAFETY_FIX,
};

// Rule 11: new suppressions. The token alternatives end in a character class so that this file's
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
const MARKDOWN = /\.(?:mdx?|mdc|markdown)$/i;

/** The suppression a line of `path` carries, or undefined; Markdown may name them. It is the
 * directive through the end of the line, or a test call's `.skip(` alone: a line edited around it
 * (a renamed skipped test, a changed dependency list) keeps the same suppression. */
function suppressionIn(path: string, line: string): string | undefined {
  if (MARKDOWN.test(path)) return undefined;
  const skipped = SCRIPT_FILE.test(path) && TEST_FILE.test(path) && SKIPPED_TEST.exec(line);
  const found =
    MARKED_DIRECTIVE.exec(line)?.[1] ??
    (BLOCK_COMMENT_FILE.test(path) ? LINE_START_DIRECTIVE.exec(line)?.[1] : undefined) ??
    (path.endsWith(".rs") ? RUST_ALLOW.exec(line)?.[0] : undefined) ??
    (skipped ? skipped[0].replace(/\s/g, "") : undefined);
  return found?.trim();
}

// Rule 4: relative Markdown links, parsed by markdown-links.ts.

/** Broken links in `files`; `exists` answers for tracked files and directories. */
function brokenLinks(
  files: { path: string; text: string; only?: (target: string) => boolean }[],
  exists: (path: string) => boolean,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files)
    for (const link of markdownLinks(file.text)) {
      const path = linkPath(file.path, link.target);
      if (path === undefined || path === "." || (file.only && !file.only(path))) continue;
      // A path outside the repository (`../x`) is never tracked.
      if (exists(path)) continue;
      violations.push({
        rule: "markdown-links",
        location: `${file.path}:${link.line}`,
        found: `link ${link.target} names ${path}, which is not a tracked file or directory`,
      });
    }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  const lines: string[] = [];
  for (const rule of Object.keys(FIX) as Rule[]) {
    const ofRule = violations.filter((violation) => violation.rule === rule);
    if (ofRule.length === 0) continue;
    lines.push(`Blocked by hard rule ${rule} (${ofRule.length}):`);
    for (const { location, found } of ofRule) lines.push(`  ${location}: ${found}`);
    lines.push(`  Fix: ${FIX[rule]}`, "");
  }
  lines.push("The hard rules are described in docs/agents/git-hooks/hard-rules.md.");
  return lines.join("\n");
}

// The git side: what the change is, read from the index or from commits, never the working tree.

const text = (args: string[]) => git(args).toString();

function trackedPaths(source: ChangeSource): string[] {
  const args =
    source.kind === "staged"
      ? ["ls-files", "-z"]
      : ["ls-tree", "-r", "-z", "--name-only", source.head];
  return [...new Set(text(args).split("\0").filter(Boolean))];
}

/** Files' content at a revision, or in the index when it is undefined. */
export function readFiles(revision: string | undefined, paths: string[]): Map<string, string> {
  const contents = new Map<string, string>();
  if (paths.length === 0) return contents;
  const prefix = `${revision ?? ""}:`;
  const output = git(["cat-file", "--batch"], paths.map((path) => prefix + path).join("\n") + "\n");
  let position = 0;
  for (const path of paths) {
    const end = output.indexOf(10, position);
    const header = output.subarray(position, end).toString();
    position = end + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    contents.set(path, output.subarray(position, position + size).toString());
    position += size + 1;
  }
  return contents;
}

/** Where the change's content is: the index (undefined) or the range head. */
export const resultRevision = (source: ChangeSource) =>
  source.kind === "staged" ? undefined : source.head;

/** The skills skills-lock.json registers, from a file's text. */
function lockedSkills(lock: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lock);
  } catch (error) {
    throw new Error(`skills-lock.json is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("skills-lock.json is not a JSON object");
  const skills = (parsed as { skills?: unknown }).skills ?? {};
  if (typeof skills !== "object" || skills === null)
    throw new Error("skills-lock.json: `skills` is not an object");
  return Object.keys(skills);
}

/** Whether a path is under a skill directory skills-lock.json registers
 * (`.agents/skills/<name>/`), read from the change's base (`policyRevision`) once, when asked. */
function exemption(source: ChangeSource): (path: string) => boolean {
  let directories: string[] | undefined;
  return (path) => {
    if (directories === undefined) {
      const lock = readFiles(policyRevision(source), ["skills-lock.json"]).get("skills-lock.json");
      const skills = lock === undefined ? [] : lockedSkills(lock);
      directories = skills.map((name) => `.agents/skills/${name}/`);
    }
    return directories.some((directory) => path.startsWith(directory));
  };
}

type Change = { status: string; path: string; from?: string };

function changedFiles(source: ChangeSource): Change[] {
  const fields = text(diffArgs(source, "--name-status", "-z", "-M", "-l0")).split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length;) {
    const status = fields[i++]!;
    if (/^[RC]/.test(status)) changes.push({ status, from: fields[i++], path: fields[i++]! });
    else changes.push({ status, path: fields[i++]! });
  }
  return changes;
}

type Line = { path: string; line: number; text: string };

/** Every added line of the change, with its line number in the new file, and every removed line
 * with its old path. */
function changedLines(source: ChangeSource): { added: Line[]; removed: Line[] } {
  // `--text`: a `-diff` attribute or a NUL byte would otherwise hide the lines.
  const args = diffArgs(source, "-p", "--text", "-U0", "--no-color", "-M", "-l0");
  const patch = text(args).split("\n");
  const added: Line[] = [];
  const removed: Line[] = [];
  // Git ends a header's name with a TAB when it contains a space.
  const header = (row: string, side: string) => {
    const name = unquote(row.slice(4).replace(/\t$/, ""));
    return name === "/dev/null" ? undefined : name.slice(side.length);
  };
  let oldPath: string | undefined;
  let path: string | undefined;
  // Inside a hunk, its line counts tell an added `++ x` or removed `-- x` from a file header.
  let oldLeft = 0;
  let newLeft = 0;
  let line = 0;
  for (const row of patch) {
    if (newLeft > 0 && row.startsWith("+")) {
      if (path) added.push({ path, line, text: row.slice(1) });
      line++;
      newLeft--;
      continue;
    }
    if (oldLeft > 0 && row.startsWith("-")) {
      if (oldPath) removed.push({ path: oldPath, line: 0, text: row.slice(1) });
      oldLeft--;
      continue;
    }
    if (row.startsWith("diff --git ")) oldPath = path = undefined;
    else if (row.startsWith("--- ")) oldPath = header(row, "a/");
    else if (row.startsWith("+++ ")) path = header(row, "b/");
    else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
      if (hunk) {
        oldLeft = Number(hunk[1] ?? 1);
        line = Number(hunk[2]);
        newLeft = Number(hunk[3] ?? 1);
      }
    }
  }
  return { added, removed };
}

/** Broken links in the Markdown of `source`'s result: all of it when `changes` is undefined. */
function linkViolations(
  source: ChangeSource,
  exempt: (path: string) => boolean,
  changes?: Change[],
): Violation[] {
  // A change checks the Markdown it adds or edits, and the links into what it deletes or renames.
  const edited = new Set(
    changes?.filter((change) => !change.status.startsWith("D")).map((change) => change.path),
  );
  const removed = (changes ?? []).flatMap((change) =>
    change.status.startsWith("D")
      ? [change.path]
      : change.status.startsWith("R")
        ? [change.from!]
        : [],
  );
  if (changes && removed.length === 0 && ![...edited].some((path) => MARKDOWN.test(path)))
    return [];
  const tracked = trackedPaths(source);
  const exists = new Set(tracked);
  for (const path of tracked)
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) exists.add(dir);
  const markdown = tracked.filter((path) => MARKDOWN.test(path) && !exempt(path));
  const intoRemoved = (path: string) =>
    removed.some((gone) => gone === path || gone.startsWith(`${path}/`));
  const checked = changes
    ? markdown.filter((path) => edited.has(path) || removed.length > 0)
    : markdown;
  const contents = readFiles(resultRevision(source), checked);
  return brokenLinks(
    checked.map((path) => ({
      path,
      text: contents.get(path) ?? "",
      only: changes && !edited.has(path) ? intoRemoved : undefined,
    })),
    (path) => exists.has(path),
  );
}

function markdownLineCount(text: string): number {
  if (text.length === 0) return 0;
  const newlineCount = text.split("\n").length - 1;
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}

/** Markdown at 200 lines or more in `source`'s result, limited to changed files when provided. */
function markdownLineViolations(
  source: ChangeSource,
  exempt: (path: string) => boolean,
  changes?: Change[],
): Violation[] {
  const candidates =
    changes === undefined
      ? trackedPaths(source)
      : changes.filter((change) => !change.status.startsWith("D")).map((change) => change.path);
  const checked = [...new Set(candidates.filter((path) => MARKDOWN.test(path) && !exempt(path)))];
  const contents = readFiles(resultRevision(source), checked);
  return checked.flatMap((path) => {
    const lines = markdownLineCount(contents.get(path) ?? "");
    return lines < 200
      ? []
      : [{ rule: "markdown-lines" as const, location: path, found: `${lines} lines` }];
  });
}

/** Suppressions the change adds. One the change also removes from a checked file, anywhere, was
 * moved or edited around: each removed suppression accounts for one identical added one. */
function suppressionViolations(
  source: ChangeSource,
  exempt: (path: string) => boolean,
): Violation[] {
  const suppression = ({ path, text }: Line) =>
    exempt(path) ? undefined : suppressionIn(path, text);
  const { added, removed } = changedLines(source);
  const moved = new Map<string, number>();
  for (const key of removed.map(suppression)) if (key) moved.set(key, (moved.get(key) ?? 0) + 1);
  return added.flatMap((line) => {
    const key = suppression(line);
    if (!key) return [];
    const left = moved.get(key) ?? 0;
    moved.set(key, left - 1);
    if (left > 0) return [];
    const found = line.text.trim();
    return [
      {
        rule: "new-suppression" as const,
        location: `${line.path}:${line.line}`,
        found: found.length > 120 ? `${found.slice(0, 117)}...` : found,
      },
    ];
  });
}

/** Rule 12, the author and committer identity (commit-identity.ts), as violations. */
function identityViolations(matches: IdentityMatch[]): Violation[] {
  return matches.map((match) => ({ rule: "author-identity", ...match }));
}

async function sizeRatchet(
  source: ChangeSource,
  exempt: (path: string) => boolean,
): Promise<Violation[]> {
  const base = source.kind === "staged" ? "HEAD" : "the base";
  const violations = (await sizeViolations(source)).filter((violation) => !exempt(violation.path));
  return violations.map((violation) => ({
    rule: "size-ratchet",
    location: violation.path,
    found: describeViolation(violation, base),
  }));
}

const NO_BASE = "::warning::No base commit to diff from, so the hard rules were not checked.";

const isCommit = (revision: string) =>
  Bun.spawnSync(["git", "rev-parse", "--verify", "-q", `${revision}^{commit}`], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

/** The file rules over a change: size, Markdown length and links, and new suppressions. */
async function fileViolations(source: ChangeSource): Promise<Violation[]> {
  const exempt = exemption(source);
  const changes = changedFiles(source);
  return [
    ...(await sizeRatchet(source, exempt)),
    ...markdownLineViolations(source, exempt, changes),
    ...linkViolations(source, exempt, changes),
    ...suppressionViolations(source, exempt),
    ...migrationSafetyViolations(source),
  ];
}

const USAGE =
  "usage: hard-rules.ts --staged | --range <base> <head> [--authors-since <rev>]... | --all";

/** The violations of the mode `args` selects, or a warning when there is nothing to judge. */
async function check(args: string[]): Promise<Violation[] | string> {
  const [mode, ...rest] = args;
  if (mode === "--staged" && rest.length === 0) {
    return [
      ...(await fileViolations({ kind: "staged" })),
      ...identityViolations(stagedIdentities()),
    ];
  }
  const [baseRev, headRev, ...options] = rest;
  const since = options.filter((_, i) => i % 2 === 1);
  // Flag, value, flag, value: a value may be empty (CI's `before` on a pull request), not a flag.
  const sinceOnly = options.every((option, i) =>
    i % 2 === 1 ? !option.startsWith("--") : option === "--authors-since",
  );
  const pair = baseRev !== undefined && headRev !== undefined;
  if (mode === "--range" && pair && options.length % 2 === 0 && sinceOnly) {
    // No successful run to diff from yet, or a run a deploy or release workflow dispatched.
    if (!isCommit(baseRev)) return NO_BASE;
    const head = text(["rev-parse", "--verify", `${headRev}^{commit}`]).trim();
    // A pull request's base may have moved on: judge only what the head adds, as `git diff A...B`.
    const mergeBase = Bun.spawnSync(["git", "merge-base", baseRev, head], { stderr: "ignore" });
    if (mergeBase.exitCode !== 0) throw new Error(`${baseRev} and ${headRev} have no merge base`);
    const base = mergeBase.stdout.toString().trim();
    // A push's own commits; with no usable `before` (a new branch, a force push), the whole range.
    const usable = since.filter(isCommit);
    const authorsFrom = usable.length > 0 ? usable : [baseRev];
    return [
      ...(await fileViolations({ kind: "range", base, head })),
      ...identityViolations(commitIdentities([head, ...authorsFrom.map((rev) => `^${rev}`)])),
    ];
  }
  if (mode === "--all" && rest.length === 0) {
    // Only the range's head is read when no changes are given.
    const head = text(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    const source: ChangeSource = { kind: "range", base: head, head };
    const exempt = exemption(source);
    return [
      ...markdownLineViolations(source, exempt),
      ...linkViolations(source, exempt),
      ...identityViolations(commitIdentities([head])),
    ];
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  // Bad input (a malformed skills-lock.json, unrelated commits): one line and exit 2, no stack.
  const violations = await check(process.argv.slice(2)).catch((error: Error) => {
    const annotation = process.env.GITHUB_ACTIONS === "true" ? "::error::" : "";
    console.error(`${annotation}hard-rules: ${error.message}`);
    process.exit(2);
  });
  if (typeof violations === "string") console.log(violations);
  else if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exit(1);
  }
}

// Commit granularity (task #595): one commit does one thing. Four rules over each
// non-merge commit in a range:
//
//   commit-title   the first line is a Conventional Commit title (`feat(scope): …`); `Revert "…"`, `Reapply "…"`,
//                  `fixup!`, `squash!` and `amend!` commits pass;
//   revert-effect  the message carries a `Revert-effect:` trailer saying what reverting
//                  this commit would break (`none` is fine for docs and tests);
//   rename-purity  every detected rename scores R100 — a rename that also edits is two
//                  commits (the rename, then the edit);
//   commit-mix     a commit that extracts code into a new file AND changes behavior:
//                  deleted lines (>= 20 trimmed chars) that reappear in the new files'
//                  additions count as moved; when moved reaches 30 lines and the
//                  non-move share of changed lines is >= 40%, split the commit.
//
// `Granularity-exempt: <reason>` in the message bypasses rename-purity and commit-mix —
// never revert-effect — and the bypass is reported, not silent. PUSHED_GRANULARITY_EXEMPTIONS
// does the same for one already-pushed SHA whose message can no longer change. Merge commits are exempt
// from all four. The commit-msg hook checks only the message; hard-rules.ts --range
// (pre-push and CI) checks whole commits. --staged skips these rules: the index has no
// message for a trailer or an exemption to live in.
//
// usage: bun scripts/ci/commit-granularity.ts --message <file>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REVERT_EFFECT_FIX =
  "Add a `Revert-effect: <what reverting this commit would break>` trailer to the message (`none` for docs and tests only).";
export const RENAME_PURITY_FIX =
  "A rename that also edits content is two commits: first the pure rename (R100), then the edit. If both belong together anyway, add `Granularity-exempt: <reason>`.";
export const COMMIT_MIX_FIX =
  "This commit moves code into a new file and changes behavior in one step. Split it: one commit that only moves the code (same lines, new home), one that changes behavior. If they must stay together, add `Granularity-exempt: <reason>`.";

export const COMMIT_TITLE_FIX =
  'Start the message with a Conventional Commit title: `<type>(<optional scope>)!: <description>`, where type is feat, fix, docs, test, refactor, chore, perf, ci, build, style or revert. `Merge`, `Revert "…"`, `Reapply "…"`, `fixup!`, `squash!` and `amend!` titles pass.';

// A commit already pushed cannot gain a `Granularity-exempt:` trailer (a squash merge, a
// rebase), so the same two diff rules can be lifted for one full SHA at a time here — only
// after the user approves, with the reason recorded. commit-title and revert-effect still apply.
export const PUSHED_GRANULARITY_EXEMPTIONS: Record<string, string> = {
  "6a74b2d6ca594d65ba9ccd99045668345dcfcc54":
    "PR #520 squash-merged; the original 8 commits each passed granularity. Frank approved the exemption 2026-11-17.",
};

const MIN_MOVED_LINES = 30;
const MIX_RATIO = 0.4;
const MIN_LINE = 20;

const TITLE =
  /^(?:(?:feat|fix|docs|test|refactor|chore|perf|ci|build|style|revert)(?:\([^()\s][^()]*\))?!?: \S|Merge |Revert "|Reapply "|(?:fixup|squash|amend)! )/;
const REVERT_TRAILER = /^Revert-effect:[ \t]*\S/m;
const EXEMPT_TRAILER = /^Granularity-exempt:[ \t]*(\S.*)$/m;

type Rule = "commit-title" | "revert-effect" | "rename-purity" | "commit-mix";
export type GranularityViolation = { rule: Rule; sha: string; found: string };
export type GranularityExemption = { sha: string; reason: string };
export type GranularityResult = {
  violations: GranularityViolation[];
  exemptions: GranularityExemption[];
};

const norm = (line: string) => line.trim();

/** The `Granularity-exempt:` reason a message carries, if any. */
export function exemptReason(message: string): string | undefined {
  return EXEMPT_TRAILER.exec(message)?.[1]?.trim();
}

/** Whether the message's first line (comment lines aside) is a Conventional Commit title. */
export function hasConventionalTitle(message: string): boolean {
  const title = message.split("\n").find((line) => !line.startsWith("#"));
  return title !== undefined && TITLE.test(title);
}

/** Whether the message satisfies the `Revert-effect:` trailer rule. */
export function hasRevertEffect(message: string): boolean {
  return REVERT_TRAILER.test(message);
}

interface FileChunk {
  path: string;
  isNew: boolean;
  added: Set<string>;
  deleted: Set<string>;
}

/** Split a `git show -U0`/`git diff -U0` patch into per-file added/deleted line sets. */
export function patchFiles(patch: string): FileChunk[] {
  const files: FileChunk[] = [];
  let current: FileChunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const row of patch.split("\n")) {
    if (newLeft > 0 && row.startsWith("+")) {
      const text = norm(row.slice(1));
      if (text.length >= MIN_LINE) current?.added.add(text);
      newLeft--;
      continue;
    }
    if (oldLeft > 0 && row.startsWith("-")) {
      const text = norm(row.slice(1));
      if (text.length >= MIN_LINE) current?.deleted.add(text);
      oldLeft--;
      continue;
    }
    if (row.startsWith("diff --git ")) {
      const match = /^a\/(.+) b\/(.+)$/.exec(row.slice("diff --git ".length).trim());
      current = match
        ? { path: match[2]!, isNew: false, added: new Set(), deleted: new Set() }
        : undefined;
      if (current) files.push(current);
    } else if (row.startsWith("new file mode") && current) {
      current.isNew = true;
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(row);
      if (hunk) {
        oldLeft = Number(hunk[1] ?? 1);
        newLeft = Number(hunk[2] ?? 1);
      }
    }
  }
  return files;
}

/** Moved/non-move accounting for one commit's patch; undefined when it is not a
 * large-enough extraction to judge. */
export function mixStats(
  patch: string,
): { moved: number; nonMove: number; ratio: number } | undefined {
  const files = patchFiles(patch);
  const deletedPool = new Set<string>();
  for (const file of files) for (const line of file.deleted) deletedPool.add(line);
  // Only a line that reappears in a new file is moved: a line deleted and added back in an
  // existing file (re-indented, reordered, moved between existing files) is not.
  const movedLines = new Set<string>();
  for (const file of files)
    if (file.isNew) for (const line of file.added) if (deletedPool.has(line)) movedLines.add(line);
  // A moved line counts twice, where it left and where it landed.
  const moved = movedLines.size * 2;
  if (moved < MIN_MOVED_LINES) return undefined;
  let nonMove = 0;
  for (const file of files) {
    for (const line of file.added) if (!movedLines.has(line)) nonMove++;
    for (const line of file.deleted) if (!movedLines.has(line)) nonMove++;
  }
  const total = moved + nonMove;
  return { moved, nonMove, ratio: total === 0 ? 0 : nonMove / total };
}

/** `R<100` entries of a `git show --name-status -M` listing, as `old -> new` strings. */
export function sub100Renames(nameStatus: string): string[] {
  const found: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const match = /^R(\d+)\t(.+)\t(.+)$/.exec(line);
    if (match && Number(match[1]) < 100) found.push(`${match[2]} -> ${match[3]}`);
  }
  return found;
}

// A gate must not pass on a git error: rev-list failing used to read as "zero commits".
const git = (args: string[], cwd?: string) => {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", cwd });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result;
};
const gitText = (args: string[], cwd?: string) => git(args, cwd).stdout.toString();

function commitMessage(sha: string, cwd?: string): string {
  return gitText(["show", "-s", "--format=%B", sha], cwd);
}

function isMerge(sha: string, cwd?: string): boolean {
  return (
    gitText(["show", "-s", "--format=%P", sha], cwd).trim().split(/\s+/).filter(Boolean).length > 1
  );
}

/** Granularity violations and exemptions for each commit `base..head` adds. */
export function rangeGranularity(
  base: string,
  head: string,
  pushedExemptions: Record<string, string> = PUSHED_GRANULARITY_EXEMPTIONS,
  cwd?: string,
): GranularityResult {
  const result: GranularityResult = { violations: [], exemptions: [] };
  const shas = gitText(["rev-list", "--reverse", `${base}..${head}`], cwd)
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean);
  for (const sha of shas) {
    if (isMerge(sha, cwd)) continue;
    const message = commitMessage(sha, cwd);
    const exempt = exemptReason(message) ?? pushedExemptions[sha];
    if (exempt) result.exemptions.push({ sha: sha.slice(0, 9), reason: exempt });
    if (!hasConventionalTitle(message))
      result.violations.push({
        rule: "commit-title",
        sha: sha.slice(0, 9),
        found: `title is not a Conventional Commit: ${message.split("\n")[0]!.slice(0, 80)}`,
      });
    if (!hasRevertEffect(message))
      result.violations.push({
        rule: "revert-effect",
        sha: sha.slice(0, 9),
        found: "no Revert-effect trailer",
      });
    if (exempt) continue;
    const nameStatus = gitText(["show", "--format=", "--name-status", "-M", "-l0", sha], cwd);
    for (const rename of sub100Renames(nameStatus))
      result.violations.push({ rule: "rename-purity", sha: sha.slice(0, 9), found: rename });
    const patch = gitText(["show", "--format=", "--unified=0", "--text", "-M", "-l0", sha], cwd);
    const stats = mixStats(patch);
    if (stats && stats.ratio >= MIX_RATIO)
      result.violations.push({
        rule: "commit-mix",
        sha: sha.slice(0, 9),
        found: `${stats.nonMove} non-move of ${stats.moved + stats.nonMove} changed lines (${Math.round(stats.ratio * 100)}%) with ${stats.moved} moved lines`,
      });
  }
  return result;
}

/** Hard-rules' per-commit checks over `base..head`; exemptions are reported, not violations. */
export async function granularityFor(base: string, head: string) {
  const result = rangeGranularity(base, head);
  if (result.exemptions.length > 0) {
    const lines = result.exemptions.map((e) => `- \`${e.sha}\`: ${e.reason}`);
    const text = `Granularity exemptions used:\n${lines.join("\n")}`;
    console.log(`::warning::${text}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      const file = Bun.file(summary);
      const existing = (await file.exists()) ? await file.text() : "";
      await Bun.write(summary, `${existing}${text}\n\n`).catch(() => {});
    }
  }
  return result.violations;
}

// The commit-msg hook's whole job: the message file git hands it ($1).
async function checkMessageFile(path: string): Promise<number> {
  // A merge commit carries no trailer requirement.
  const mergeHead = gitText(["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
  const resolved = mergeHead.startsWith("/")
    ? mergeHead
    : join(gitText(["rev-parse", "--show-toplevel"]).trim(), mergeHead);
  if (existsSync(resolved)) return 0;
  const message = readFileSync(path, "utf8");
  // Comments (# lines) are stripped by git before this hook runs on most setups,
  // but a hand-run or unusual editor may leave them; the trailer regex only looks
  // at real lines anyway.
  const problems = [
    ...(hasConventionalTitle(message)
      ? []
      : [`commit-msg: the title is not a Conventional Commit.\n${COMMIT_TITLE_FIX}`]),
    ...(hasRevertEffect(message)
      ? []
      : [`commit-msg: missing Revert-effect trailer.\n${REVERT_EFFECT_FIX}`]),
  ];
  for (const problem of problems) console.error(problem);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const [flag, file] = process.argv.slice(2);
  if (flag !== "--message" || !file) {
    console.error("usage: commit-granularity.ts --message <file>");
    process.exit(2);
  }
  process.exit(await checkMessageFile(file));
}

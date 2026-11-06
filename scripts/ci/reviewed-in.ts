// Reviewed-in warning check (task #593): a commit that touches a high-risk path —
// scripts/ci/high-risk-paths.txt — should carry a `Reviewed-in: #<channel>:#<task>`
// trailer naming where it was reviewed (the message id of the "push it" reply is
// welcome but optional). Warn-only for its first two weeks: each offending commit gets
// a `::warning::` annotation and a step-summary table; nothing here ever fails a run.
// Merge commits are skipped — their commits are judged individually — and the check
// never talks to CoForge: it validates the trailer's shape only.
//
// usage: bun scripts/ci/reviewed-in.ts --range <base> <head>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATTERNS_FILE = join(import.meta.dir, "high-risk-paths.txt");

// `Reviewed-in: #coforge:#601` or `Reviewed-in: #coforge:#601 01a1b049-…`: a task ref is
// required, anything after it must be a single token (the review message id).
const REVIEWED_IN = /^Reviewed-in:[ \t]*#\S+:#\d+([ \t]+\S+)?[ \t]*$/m;

/** Whether the message carries a well-formed `Reviewed-in:` trailer. */
export function hasReviewedIn(message: string): boolean {
  return REVIEWED_IN.test(message);
}

/** A predicate over repository paths built from the gitignore-style patterns file. */
export function riskMatcher(patterns: string[]): (path: string) => boolean {
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  return (path) => globs.some((glob) => glob.match(path));
}

/** The pattern file's lines: trimmed, blanks and `#` comments dropped. */
export function loadPatterns(path = PATTERNS_FILE): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export type ReviewFinding = { sha: string; paths: string[] };

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
};

/** Every path a commit touches; for a rename or copy both sides count. */
function commitPaths(sha: string): string[] {
  const paths = new Set<string>();
  for (const line of git(["show", "--format=", "--name-status", sha]).split("\n")) {
    if (!line.trim()) continue;
    for (const field of line.split("\t").slice(1)) {
      const path = field.trim().replace(/^"|"$/g, "");
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

/** Findings for each non-merge commit `base..head` adds that touches a risky path
 * without the trailer. `base` may be any revision; the merge base with `head` is used,
 * as `git diff A...B` does for a pull request. */
export function rangeFindings(
  base: string,
  head: string,
  match: (path: string) => boolean,
): ReviewFinding[] {
  const mergeBase = git(["merge-base", base, head]).split("\n")[0]!.trim();
  const findings: ReviewFinding[] = [];
  const shas = git(["rev-list", "--reverse", "--no-merges", `${mergeBase}..${head}`])
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean);
  for (const sha of shas) {
    const message = git(["show", "-s", "--format=%B", sha]);
    if (hasReviewedIn(message)) continue;
    const paths = commitPaths(sha).filter(match);
    if (paths.length > 0) findings.push({ sha: sha.slice(0, 9), paths });
  }
  return findings;
}

const MAX_PATHS_PER_COMMIT = 5;

function shortPaths(finding: ReviewFinding): string {
  const shown = finding.paths.slice(0, MAX_PATHS_PER_COMMIT).join(", ");
  const more = finding.paths.length - MAX_PATHS_PER_COMMIT;
  return `${finding.sha}: ${shown}${more > 0 ? ` (+${more} more)` : ""}`;
}

async function report(findings: ReviewFinding[]): Promise<void> {
  for (const finding of findings) {
    console.log(
      `::warning::commit ${shortPaths(finding)} touches high-risk paths without a Reviewed-in trailer`,
    );
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary || findings.length === 0) return;
  const rows = findings.map(
    (f) => `| \`${f.sha}\` | ${f.paths.map((p) => `\`${p}\``).join("<br>")} |`,
  );
  const text = [
    "## Reviewed-in warnings",
    "",
    "Commits touching high-risk paths without a `Reviewed-in:` trailer (warn-only, task #593):",
    "",
    "| commit | high-risk paths |",
    "| --- | --- |",
    ...rows,
    "",
    "Add `Reviewed-in: #<channel>:#<task> [message-id]` to the commit message; commits carrying it stay silent.",
    "",
  ].join("\n");
  const file = Bun.file(summary);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(summary, `${existing}${text}\n`).catch(() => {});
}

if (import.meta.main) {
  const [flag, base, head] = process.argv.slice(2);
  if (flag !== "--range" || !base || !head) {
    console.error("usage: reviewed-in.ts --range <base> <head>");
    process.exit(2);
  }
  try {
    const findings = rangeFindings(base, head, riskMatcher(loadPatterns()));
    await report(findings);
  } catch (error) {
    // Warn-only means the check itself can never block: a git or file failure is a
    // warning, not a failed run.
    console.log(`::warning::reviewed-in check could not run: ${error}`);
  }
}

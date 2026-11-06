// The whitespace check of the shared --range entrypoint (task #628): the same
// `git diff --check` CI's "Select checks" step applies, judged from the range's
// merge base exactly as the hard rules resolve it, so pre-push refuses the
// trailing whitespace and blank line at EOF that step would reject only after
// the push. range-checks.ts runs it next to hard-rules.ts; its exit code only
// adds failures — the hard rules' verdict still leads there.
// usage: bun scripts/ci/diff-check.ts --range <base> <head> [--authors-since <rev>]...
const USAGE = "usage: diff-check.ts --range <base> <head>";

const isCommit = (revision: string) =>
  Bun.spawnSync(["git", "cat-file", "-e", `${revision}^{commit}`], { stderr: "ignore" })
    .exitCode === 0;

const [, , mode, baseRev, headRev] = process.argv;
if (mode !== "--range" || baseRev === undefined || headRev === undefined) {
  console.error(`diff-check: ${USAGE}`);
  process.exit(2);
}
// As the hard rules' NO_BASE: with nothing to diff from, CI's own check still
// runs after the push, so this warns instead of blocking.
if (!isCommit(baseRev)) {
  console.log("::warning::No base commit to diff from, so the whitespace check did not run.");
  process.exit(0);
}
const head = Bun.spawnSync(["git", "rev-parse", "--verify", `${headRev}^{commit}`]);
if (head.exitCode !== 0) {
  console.error(`diff-check: ${headRev} is not a commit`);
  process.exit(2);
}
const mergeBase = Bun.spawnSync(["git", "merge-base", baseRev, headRev]);
if (mergeBase.exitCode !== 0) {
  console.error(`diff-check: ${baseRev} and ${headRev} have no merge base`);
  process.exit(2);
}
const base = mergeBase.stdout.toString().trim();
const headSha = head.stdout.toString().trim();
const diff = Bun.spawnSync(["git", "diff", "--check", base, headSha], {
  stdout: "pipe",
  stderr: "pipe",
});
if (diff.exitCode === 0) process.exit(0);
// Any non-zero exit is reported and blocks: the revisions are already verified
// commits with a merge base, so what remains is whitespace findings — and an
// unexpected git failure must fail closed, not pass.
console.error(`diff-check: whitespace errors in ${baseRev}...${headRev}:`);
process.stderr.write(diff.stdout);
process.stderr.write(diff.stderr);
process.exit(1);

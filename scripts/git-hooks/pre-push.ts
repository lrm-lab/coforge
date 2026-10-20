// The pre-push hook's check (`.githooks/pre-push` runs it): the hard rules
// (scripts/ci/hard-rules.ts --range) on exactly what each pushed ref sends. Git writes one line per
// ref on stdin, `<local ref> <local sha> <remote ref> <remote sha>`
// (https://git-scm.com/docs/githooks#_pre_push). A ref the remote already has is judged from its
// remote sha, with only the pushed commits' identities checked, as CI does on a push. A new ref, or
// one whose remote sha is unknown here, is judged from its merge base with origin/main, as a pull
// request is; without one it is skipped with a warning. A deletion sends nothing to check.
// See docs/agents/git-hooks.md.
import { join } from "node:path";

const checker = join(import.meta.dir, "../ci/hard-rules.ts");
const ZERO = /^0+$/;

function git(...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

const isCommit = (sha: string) => git("cat-file", "-e", `${sha}^{commit}`) !== undefined;

/** Whether the ref `line` describes may be pushed. */
function refPasses(line: string): boolean {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
  if (!localRef || !localSha || ZERO.test(localSha)) return true;
  const known = remoteSha && !ZERO.test(remoteSha) && isCommit(remoteSha);
  const base = known ? remoteSha : git("merge-base", "origin/main", localSha);
  if (!base) {
    console.error(
      `pre-push: ${localRef} is new and has no merge base with origin/main, so it was not ` +
        "checked here (`git fetch origin` to check it; CI checks it after the push).",
    );
    return true;
  }
  const args = ["--range", base, localSha, ...(known ? ["--authors-since", remoteSha] : [])];
  const result = Bun.spawnSync([process.execPath, checker, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode === 0) return true;
  console.error(
    `pre-push: ${localRef} -> ${remoteRef} breaks the hard rules (judged from ${base}).`,
  );
  return false;
}

if (import.meta.main) {
  const lines = (await Bun.stdin.text()).split("\n").filter(Boolean);
  // Every ref is judged, so one push reports all of them.
  const results = lines.map(refPasses);
  process.exit(results.every(Boolean) ? 0 : 1);
}

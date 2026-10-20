// The pre-push hook's check (`.githooks/pre-push` runs it): the hard rules
// (scripts/ci/hard-rules.ts --range) on exactly what each pushed ref sends. Git writes one line per
// ref on stdin, `<local ref> <local sha> <remote ref> <remote sha>`
// (https://git-scm.com/docs/githooks#_pre_push). The file rules judge a ref from the later of its
// fork points from the remote sha and from origin/main, so a branch that merged or rebased onto
// main is not blamed for main's commits; a new ref, or a remote sha unknown here, from its merge
// base with origin/main. Identities are checked for the commits on neither the remote ref nor
// origin/main, as CI checks a push or a pull request. A ref with no such base, or one the checker
// rejects as bad input (exit 2), is skipped with a warning. A deletion sends nothing to check.
// See docs/agents/git-hooks/hard-rules.md.
import { join } from "node:path";

const checker = join(import.meta.dir, "../ci/hard-rules.ts");
const ZERO = /^0+$/;

function git(...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

const isCommit = (sha: string) => git("cat-file", "-e", `${sha}^{commit}`) !== undefined;
const isAncestor = (ancestor: string, of: string) =>
  Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, of]).exitCode === 0;

/** The later of two fork points: the descendant when one is an ancestor of the other, else
 * origin/main's, which a pull request is judged from. */
function laterBase(fromRemote: string | undefined, fromMain: string | undefined) {
  if (!fromRemote || !fromMain) return fromRemote ?? fromMain;
  return isAncestor(fromMain, fromRemote) ? fromRemote : fromMain;
}

function skipped(localRef: string, why: string): true {
  console.error(
    `pre-push: ${localRef} ${why}, so it was not checked here (CI checks it after the push).`,
  );
  return true;
}

/** Whether the ref `line` describes may be pushed. */
function refPasses(line: string): boolean {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
  if (!localRef || !localSha || ZERO.test(localSha)) return true;
  const known = remoteSha && !ZERO.test(remoteSha) && isCommit(remoteSha) ? remoteSha : undefined;
  const main = git("rev-parse", "--verify", "-q", "origin/main^{commit}");
  const base = laterBase(
    known && git("merge-base", known, localSha),
    main && git("merge-base", main, localSha),
  );
  if (!known && !main)
    return skipped(localRef, "is new and origin/main is unknown (`git fetch origin`)");
  if (!base) return skipped(localRef, "shares no history with origin/main or its remote ref");
  const since = [known, main].flatMap((rev) => (rev ? ["--authors-since", rev] : []));
  const result = Bun.spawnSync([process.execPath, checker, "--range", base, localSha, ...since], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 2) return skipped(localRef, "could not be judged (above)");
  console.error(
    `pre-push: ${localRef} -> ${remoteRef} breaks the hard rules (judged from ${base}).`,
  );
  if (remoteSha && !ZERO.test(remoteSha) && !known)
    console.error(
      "pre-push: the remote sha is unknown here, so it was judged from origin/main: run " +
        "`git fetch origin` and push again if main's commits are listed.",
    );
  return false;
}

if (import.meta.main) {
  const lines = (await Bun.stdin.text()).split("\n").filter(Boolean);
  // Every ref is judged, so one push reports all of them.
  const results = lines.map(refPasses);
  process.exit(results.every(Boolean) ? 0 : 1);
}

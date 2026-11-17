// The local gate `bun run check` (and so `mise run check`) runs first, before a push: the hooks
// must be installed (a hooks path of the user's own only warns), the commits not yet on
// origin/main must pass the hard rules and the whitespace check (scripts/ci/range-checks.ts) as CI's
// Plan checks job judges them, and the script-contract suites CI's infrastructure-contracts job would select for the
// same paths must pass (the `local` track of scripts/ci/selection.ts, the same map CI uses —
// this is what keeps a scripts/deploy format failure like #592's out of main). It only reads:
// it never changes git config. It does nothing in CI (`CI` set to anything but `false` or `0`),
// which runs the hard rules itself, or outside a git work tree (a Docker build context, an
// unpacked tarball).
// See docs/agents/git-hooks/limits.md.
//
// usage: bun scripts/ci/local-gate.ts   (from the repository root; exit 1 prints the fix)
import { join } from "node:path";
import { checkRepoHooksPath } from "../git-hooks/hooks-path";
import {
  downstreamWorkspaces,
  lintFilesStrict,
  runValidateEach,
  runWorkspaceTypechecks,
} from "./run-checks";
import { selectChecks } from "./selection";

const checker = join(import.meta.dir, "range-checks.ts");

function git(...args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

/** HEAD's merge base with the local origin/main and that ref, or null — reason already logged —
 * when the unpushed range cannot be judged: no origin, unknown origin/main, or unrelated history. */
function mergeBase(): { base: string; main: string } | null {
  if (git("remote", "get-url", "origin").exitCode !== 0) {
    console.log("local gate: no `origin` remote, so commits not yet on main were not checked.");
    return null;
  }
  const main = git("rev-parse", "--verify", "-q", "origin/main^{commit}");
  if (main.exitCode !== 0) {
    console.log(
      "local gate: origin/main is unknown; run `git fetch origin` to check unpushed commits.",
    );
    return null;
  }
  const base = git("merge-base", main.stdout, "HEAD");
  if (base.exitCode !== 0) {
    console.log("local gate: HEAD shares no history with origin/main; the range was not checked.");
    return null;
  }
  return { base: base.stdout, main: main.stdout };
}

/** The commits not yet on origin/main, judged as CI judges a pull request; exit 1 on violations. */
function rangeFails(range: { base: string; main: string }): boolean {
  const result = Bun.spawnSync([process.execPath, checker, "--range", range.base, "HEAD"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode === 0) return false;
  console.error(
    `local gate: judged from ${range.base}, HEAD's merge base with your local origin/main ` +
      `(${range.main}). If others' commits are listed, origin/main may be stale: run ` +
      "`git fetch origin` and re-run.",
  );
  return true;
}

/** The script-contract suites CI's infrastructure-contracts job would select for the unpushed
 * paths, through the same `local` selection track (scripts/ci/selection.ts). Each suite runs
 * `bun run test:<name>` then `bun run check:<name>` — the pair scripts/ci/validate-each.sh runs
 * in CI; that script needs jq, which is not a repository tool, so the gate runs the pair itself.
 * Every selected suite runs even after a failure, and the gate fails if any did. */
function contractChecksFail(top: string, range: { base: string }): boolean {
  const diff = git("diff", "--name-only", "--no-renames", "-z", range.base, "HEAD");
  if (diff.exitCode !== 0) {
    // A git error is not an empty diff: fail closed, as the hard rules do (task #595).
    console.error(
      `local gate: could not diff ${range.base}..HEAD; contract checks cannot be selected.`,
    );
    return true;
  }
  const paths = diff.stdout.split("\0").filter(Boolean);
  if (paths.length === 0) return false;
  let failed = false;
  const selected = selectChecks(paths, "local");
  if (selected.length > 0) {
    console.log(`local gate: script-contract checks selected: ${selected.join(", ")}`);
    if (!runValidateEach(top, "scripts", selected)) {
      console.error(`local gate: failed script-contract checks: ${selected.join(", ")}`);
      failed = true;
    }
  }
  if (!lintFilesStrict(top, paths)) failed = true;
  const affectedWorkspaces = downstreamWorkspaces(top, paths);
  if (affectedWorkspaces.length > 0 && !runWorkspaceTypechecks(top, affectedWorkspaces)) {
    failed = true;
  }
  return failed;
}

function main(): number {
  const ci = process.env.CI;
  if (ci && ci !== "false" && ci !== "0") return 0;
  const location = git("rev-parse", "--is-inside-work-tree", "--show-toplevel");
  const [inside, top] = location.stdout.split("\n");
  if (location.exitCode !== 0 || inside !== "true" || !top) return 0;
  const hooks = checkRepoHooksPath(top);
  if (!hooks.ok) console.error(`local gate: ${hooks.error}`);
  const range = mergeBase();
  // Both judgements run even when the first fails, so one `bun run check` reports everything.
  const hardRules = range ? rangeFails(range) : false;
  const contracts = range ? contractChecksFail(top, range) : false;
  return !hooks.ok || hardRules || contracts ? 1 : 0;
}

if (import.meta.main) process.exit(main());

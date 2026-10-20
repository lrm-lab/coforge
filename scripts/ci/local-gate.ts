// The local gate `bun run check` (and so `mise run check`) runs first, before a push: the
// pre-commit hook must be installed, and the commits not yet on origin/main must pass the hard
// rules (scripts/ci/hard-rules.ts) as CI's Plan checks job judges them. It only reads: it never
// changes git config. It does nothing in CI (`CI=true`), which runs the hard rules itself, or
// outside a git work tree (a Docker build context, an unpacked tarball).
// See docs/agents/git-hooks.md.
//
// usage: bun scripts/ci/local-gate.ts   (from the repository root; exit 1 prints the fix)
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOOKS_PATH = ".githooks";
const checker = join(import.meta.dir, "hard-rules.ts");

function git(...args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

/** Why the pre-commit hook does not run here, with the fix, or undefined when it does. A hooks
 * path set by `-c` or `GIT_CONFIG_*` (a CoForge Agent's shim, which forwards to the repository's
 * configuration) is not the repository's choice, as in install-hooks-path.ts. A hooks path of
 * someone's own passes only when its pre-commit runs ours: install-hooks-path.ts leaves it alone,
 * so the hook would otherwise be missing without notice. */
function hookProblem(top: string): string | undefined {
  const configured = git("config", "--show-scope", "--get-all", "core.hooksPath");
  const values = (configured.exitCode === 0 ? configured.stdout : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [scope, ...value] = line.split("\t");
      return { scope, value: value.join("\t") };
    })
    .filter(({ scope }) => scope !== "command");
  const effective = values.at(-1);
  if (!effective)
    return "pre-commit hook not installed: run `bun install` (sets core.hooksPath=.githooks)";
  if (effective.value === HOOKS_PATH) return undefined;
  const directory = effective.value.replace(/^~(?=\/)/, process.env.HOME ?? "~");
  const hook = join(resolve(top, directory), "pre-commit");
  if (existsSync(hook) && readFileSync(hook, "utf8").includes(`${HOOKS_PATH}/pre-commit`))
    return undefined;
  return (
    `core.hooksPath is "${effective.value}" (${effective.scope} config), so CoForge's pre-commit ` +
    `hook does not run: have ${hook} run .githooks/pre-commit, or unset core.hooksPath and run ` +
    "`bun install`."
  );
}

/** The commits not yet on origin/main, judged as CI judges a pull request; exit 1 on violations. */
function rangeFails(): boolean {
  if (git("remote", "get-url", "origin").exitCode !== 0) {
    console.log("local gate: no `origin` remote, so commits not yet on main were not checked.");
    return false;
  }
  const main = git("rev-parse", "--verify", "-q", "origin/main^{commit}");
  if (main.exitCode !== 0) {
    console.log(
      "local gate: origin/main is unknown; run `git fetch origin` to check unpushed commits.",
    );
    return false;
  }
  const base = git("merge-base", main.stdout, "HEAD");
  if (base.exitCode !== 0) {
    console.log("local gate: HEAD shares no history with origin/main; the range was not checked.");
    return false;
  }
  const result = Bun.spawnSync([process.execPath, checker, "--range", base.stdout, "HEAD"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode === 0) return false;
  console.error(
    `local gate: judged from ${base.stdout}, HEAD's merge base with your local origin/main ` +
      `(${main.stdout}). If others' commits are listed, origin/main may be stale: run ` +
      "`git fetch origin` and re-run.",
  );
  return true;
}

function main(): number {
  if (process.env.CI === "true") return 0;
  const location = git("rev-parse", "--is-inside-work-tree", "--show-toplevel");
  if (location.exitCode !== 0 || !location.stdout.startsWith("true")) return 0;
  const top = location.stdout.split("\n")[1]!;
  const problem = hookProblem(top);
  if (problem) console.error(`local gate: ${problem}`);
  const failed = rangeFails();
  return problem || failed ? 1 : 0;
}

if (import.meta.main) process.exit(main());

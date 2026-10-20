// The local gate `bun run check` (and so `mise run check`) runs first, before a push: the hooks
// must be installed (a hooks path of the user's own only warns), and the commits not yet on
// origin/main must pass the hard rules (scripts/ci/hard-rules.ts) as CI's Plan checks job judges
// them. It only reads: it never changes git config. It does nothing in CI (`CI` set to anything
// but `false` or `0`), which runs the hard rules itself, or outside a git work tree (a Docker
// build context, an unpacked tarball).
// See docs/agents/git-hooks/limits.md.
//
// usage: bun scripts/ci/local-gate.ts   (from the repository root; exit 1 prints the fix)
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const HOOKS_PATH = ".githooks";
const checker = join(import.meta.dir, "hard-rules.ts");

function git(...args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

/** `path` with its symlinks resolved, as far as it exists. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

/** Whether the repository's hooks are installed: an error when no `core.hooksPath` is set, a
 * warning when it names the user's own hooks directory, which install-hooks-path.ts leaves alone
 * and so does this. A hooks path set by `-c` or `GIT_CONFIG_*` (a CoForge Agent's shim, which
 * forwards to the repository's configuration) is not the repository's choice, as there. Of the
 * rest, the last value git reads wins; git resolves it (`--type=path` expands `~`) relative to the
 * top of the work tree, so `.githooks/`, `./.githooks` or its absolute path all name
 * `.githooks`; symlinks are resolved on both sides (macOS's `/var` is `/private/var`). */
function hooksStatus(top: string): { error?: string; warning?: string } {
  const configured = git("config", "--type=path", "--show-scope", "--get-all", "core.hooksPath");
  const values = (configured.exitCode === 0 ? configured.stdout : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [scope, ...value] = line.split("\t");
      return { scope, value: value.join("\t") };
    })
    .filter(({ scope }) => scope !== "command");
  const effective = values.at(-1)?.value;
  if (effective === undefined) {
    const error =
      "pre-commit hook not installed: run `bun install` (sets core.hooksPath=.githooks)";
    return { error };
  }
  if (canonical(resolve(top, effective)) === canonical(resolve(top, HOOKS_PATH))) return {};
  return {
    warning:
      `core.hooksPath is ${effective}, not .githooks: the repository's pre-commit and pre-push ` +
      "run only if your hooks call them",
  };
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
  const ci = process.env.CI;
  if (ci && ci !== "false" && ci !== "0") return 0;
  const location = git("rev-parse", "--is-inside-work-tree", "--show-toplevel");
  const [inside, top] = location.stdout.split("\n");
  if (location.exitCode !== 0 || inside !== "true" || !top) return 0;
  const hooks = hooksStatus(top);
  if (hooks.warning) console.warn(`local gate: ${hooks.warning}`);
  if (hooks.error) console.error(`local gate: ${hooks.error}`);
  const failed = rangeFails();
  return hooks.error || failed ? 1 : 0;
}

if (import.meta.main) process.exit(main());

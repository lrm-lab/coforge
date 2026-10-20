// Points this repository's `core.hooksPath` at the committed `.githooks` directory. The root
// package's `prepare` script runs it from the package root on every `bun install`, so it must
// never fail the install: outside a git work tree (a Docker build context, an unpacked tarball),
// without git, or below another repository's top level it does nothing. It never replaces a
// hooks path someone else configured; it prints one line instead.
//
// usage: bun scripts/git-hooks/install-hooks-path.ts   (from the repository root)
const HOOKS_PATH = ".githooks";

function git(...args: string[]): { exitCode: number; stdout: string } | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  } catch {
    return undefined; // git is not installed
  }
}

function install(): void {
  // Only from the top of a work tree: a non-empty prefix means this package root sits inside some
  // other repository. Git compares the paths itself, which a string comparison of top-level paths
  // gets wrong on Windows (drive-letter case, separators).
  const location = git("rev-parse", "--is-inside-work-tree", "--show-prefix");
  if (location?.exitCode !== 0) return;
  const [insideWorkTree, prefix] = location.stdout.split("\n");
  if (insideWorkTree !== "true" || prefix !== "") return;

  // `command` scope is GIT_CONFIG_* or `-c`: a CoForge Agent's injected shim directory, which
  // forwards to whatever the repository configures, so it is not a choice to respect.
  const configured = git("config", "--show-scope", "--get-all", "core.hooksPath");
  const values = (configured?.exitCode === 0 ? configured.stdout : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [scope, ...value] = line.split("\t");
      return { scope, value: value.join("\t") };
    })
    .filter(({ scope }) => scope !== "command");
  const other = values.find(({ value }) => value !== HOOKS_PATH);
  if (other) {
    console.log(
      `CoForge git hooks not enabled: core.hooksPath is already "${other.value}" (${other.scope} config); leaving it unchanged.`,
    );
    return;
  }
  if (values.some(({ scope }) => scope === "local")) return;
  git("config", "--local", "core.hooksPath", HOOKS_PATH);
}

if (import.meta.main) {
  try {
    install();
  } catch (error) {
    console.log(`CoForge git hooks not enabled: ${error instanceof Error ? error.message : error}`);
  }
}

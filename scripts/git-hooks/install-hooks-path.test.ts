import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The installer runs as the root package's `prepare` script, from the package root. Each test
// runs the real script from a throwaway directory standing in for that root.
const installer = join(import.meta.dir, "install-hooks-path.ts");

let home: string;
let root: string;

/** None of the host's git variables, no user or system config unless a test writes the global
 * file, and no repository above the temp root. */
function gitEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("GIT_")) environment[name] = value;
  return {
    ...environment,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(home),
    ...extra,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: gitEnvironment() });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** The repository-local `core.hooksPath`, or undefined when it is unset. */
function localHooksPath(cwd = root): string | undefined {
  const result = Bun.spawnSync(["git", "config", "--local", "--get", "core.hooksPath"], {
    cwd,
    env: gitEnvironment(),
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

function install(cwd = root, extra: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, installer], {
    cwd,
    env: gitEnvironment(extra),
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "coforge-install-hooks-path-")));
  root = join(home, "coforge");
  mkdirSync(root);
  writeFileSync(join(home, "gitconfig"), "");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("outside a git work tree it does nothing and succeeds", () => {
  const result = install();

  expect(result).toEqual({ exitCode: 0, output: "" });
});

test("without git on PATH it does nothing and succeeds", () => {
  git(root, "init", "-q");

  const result = install(root, { PATH: dirname(process.execPath) });

  expect(result).toEqual({ exitCode: 0, output: "" });
  expect(localHooksPath()).toBeUndefined();
});

test("it points core.hooksPath at .githooks when unset, and is idempotent", () => {
  git(root, "init", "-q");

  expect(install().exitCode).toBe(0);
  expect(localHooksPath()).toBe(".githooks");

  const again = install();
  expect(again).toEqual({ exitCode: 0, output: "" });
  expect(localHooksPath()).toBe(".githooks");
});

test("it leaves a different repository-local core.hooksPath alone and says so", () => {
  git(root, "init", "-q");
  git(root, "config", "core.hooksPath", ".husky/_");

  const result = install();

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(".husky/_");
  expect(result.output.trim().split("\n")).toHaveLength(1);
  expect(localHooksPath()).toBe(".husky/_");
});

test("it leaves a user's global core.hooksPath in charge and says so", () => {
  git(root, "init", "-q");
  writeFileSync(join(home, "gitconfig"), "[core]\n\thooksPath = ~/my-hooks\n");

  const result = install();

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("~/my-hooks");
  expect(localHooksPath()).toBeUndefined();
});

test("a hooks path injected through GIT_CONFIG_* (a CoForge Agent's shims) does not count", () => {
  git(root, "init", "-q");

  const result = install(root, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: join(home, "agent-shims"),
  });

  expect(result).toEqual({ exitCode: 0, output: "" });
  expect(localHooksPath()).toBe(".githooks");
});

test("a package root below another repository's top level does not configure that repository", () => {
  git(home, "init", "-q");

  const result = install(root);

  expect(result).toEqual({ exitCode: 0, output: "" });
  expect(localHooksPath(home)).toBeUndefined();
});

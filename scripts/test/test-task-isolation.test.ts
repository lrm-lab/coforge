import { expect, test } from "bun:test";
import { join } from "node:path";

/** How a mise test task starts its tests: through the isolated test run, named from the project
 * root so a task that first `cd`s into a package (or runs in the caller's directory) finds it. */
const ISOLATED_RUN = 'bun "{{config_root}}/scripts/test/isolated-test-run.ts" ';

type Task = { run?: string | string[]; dir?: string };

async function testTasks(): Promise<[string, Task][]> {
  const mise = Bun.TOML.parse(await Bun.file(join(import.meta.dir, "../../mise.toml")).text()) as {
    tasks: Record<string, Task>;
  };
  return Object.entries(mise.tasks).filter(([name]) => name === "test" || name.startsWith("test:"));
}

/** The commands of a task's `run`, in order: array entries, lines, and `&&` segments. */
function commands(run: Task["run"]): string[] {
  return [run ?? []]
    .flat()
    .flatMap((entry) => entry.split("\n"))
    .flatMap((line) => line.split("&&"))
    .map((command) => command.trim())
    .filter(Boolean);
}

/** A Bun child spawned without `env` gets its parent's startup environment, so the cut has to
 * happen before bun starts: every test task's test command runs through the isolated test run,
 * and no other command of the task runs tests. Inside a CoForge Agent a test outside it could act
 * as that Agent or on its Workspace. */
test("every mise test task runs its tests through the isolated test run", async () => {
  const tasks = await testTasks();
  expect(tasks.map(([name]) => name)).toContain("test:daemon");

  const unisolated = tasks.flatMap(([name, task]) => {
    const steps = commands(task.run);
    const last = steps.at(-1) ?? "";
    const before = steps.slice(0, -1).filter((step) => /\bbun (run )?test\b/.test(step));
    return [
      ...(last.startsWith(ISOLATED_RUN) ? [] : [`${name}: ${last}`]),
      ...before.map((step) => `${name}: ${step}`),
    ];
  });
  expect(unisolated).toEqual([]);
});

test("mise run test:file runs the named files in the caller's directory, isolated", async () => {
  const file = Object.fromEntries(await testTasks())["test:file"];
  expect(file?.dir).toBe("{{cwd}}");
  expect(commands(file?.run)).toEqual([`${ISOLATED_RUN}bun test`]);
});

/** How a root `package.json` test script starts its tests: scripts run in the repository root. */
const ISOLATED_SCRIPT_RUN = "bun scripts/test/isolated-test-run.ts bun test";

/** `bun run test:deploy` and the other root test scripts are run directly as well as from mise, so
 * each `bun test` they start goes through the isolated test run itself. The root `test` script
 * starts none: it fans out to `test:ci` and the packages' own `test` scripts, and `mise run test`
 * (the documented entry) runs that whole fan-out isolated. */
test("every root package.json test script runs bun test through the isolated test run", async () => {
  const { scripts } = (await Bun.file(join(import.meta.dir, "../../package.json")).json()) as {
    scripts: Record<string, string>;
  };
  const testScripts = Object.entries(scripts).filter(
    ([name]) => name === "test" || name.startsWith("test:"),
  );
  const steps = testScripts.flatMap(([name, script]) =>
    commands(script)
      .filter((step) => /\bbun test\b/.test(step))
      .map((step) => [name, step] as const),
  );
  expect(steps.map(([name]) => name)).toContain("test:ci");
  expect(
    steps.filter(([, step]) => !step.startsWith(ISOLATED_SCRIPT_RUN)).map(([name]) => name),
  ).toEqual([]);
});

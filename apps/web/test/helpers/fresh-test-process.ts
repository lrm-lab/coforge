import { resolve } from "node:path";

/** Boot configuration and irreversible shutdown belong to one process. Re-run only this case
 * in a fresh test process, preserving its assertions and the repository's credential isolation. */
export async function inFreshTestProcess(
  file: string,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  const identity = `${file}#${name}`;
  if (Bun.env.WEB_TEST_FRESH_PROCESS === identity) return run();
  const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../../../scripts/test/isolated-test-run.ts"),
      process.execPath,
      "test",
      file,
      "--test-name-pattern",
      pattern,
    ],
    {
      env: { ...process.env, WEB_TEST_FRESH_PROCESS: identity },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = stdout + stderr;
  if (exit !== 0 || !/^\s*1 pass\s*$/m.test(output))
    throw new Error(`Fresh-process test failed (${exit}):\n${output}`);
}

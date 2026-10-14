import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * `test/runtime-fetch.cases.ts` asserts Bun's per-request proxy behavior, but Bun snapshots
 * the proxy environment (including `NO_PROXY`) when a process starts, so a host that exports a
 * corporate proxy or names loopback in `NO_PROXY` decides those cases' outcome no matter what the
 * test file deletes at runtime. Run the cases file in a child process that starts with none of
 * the proxy variables set, and carry its verdict (and, on failure, its output) back here.
 *
 * See also `git-hook-shims.test.ts` in packages/daemon: Bun.spawn's default environment does not
 * follow later process.env writes, which is exactly the snapshot this guard works around.
 */
const PROXY_VARIABLES = [
  "NO_PROXY",
  "no_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

test("the runtime fetch cases run in a process Bun started without any proxy environment", async () => {
  const environment = { ...Bun.env };
  for (const name of PROXY_VARIABLES) delete environment[name];
  const child = Bun.spawn([process.execPath, "test", "./test/runtime-fetch.cases.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    console.error(
      `runtime fetch cases child run exited ${code}\n${stdout.trim()}\n${stderr.trim()}`,
    );
  }
  expect(code).toBe(0);
});

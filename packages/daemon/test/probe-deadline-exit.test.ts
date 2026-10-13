import { expect, test } from "bun:test";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "#src/code-agent/runtime-inventory";
import { VERSION_PROBE_TIMEOUT_MS } from "#src/code-agent/version-gate";

const FIXTURE = new URL("./fixtures/finished-probe-exit.ts", import.meta.url).pathname;
/** Every probe here is bounded by one of these; a probe that finished must not wait it out. */
const PROBE_TIMEOUT_MS = Math.min(CATALOG_DISCOVERY_TIMEOUT_MS, VERSION_PROBE_TIMEOUT_MS);

/** Runs the fixture's probe in its own process and reports how long that process lived. */
async function processLifetimeMs(probe: string): Promise<number> {
  const startedAt = performance.now();
  const child = Bun.spawn([process.execPath, FIXTURE, probe], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const lifetimeMs = performance.now() - startedAt;
  if (exitCode !== 0) throw new Error(`${probe} probe failed: ${await child.stderr.text()}`);
  return lifetimeMs;
}

// The child is killed by the runner, not left behind, if the product's own bound is exceeded.
const TEST_TIMEOUT_MS = 3 * PROBE_TIMEOUT_MS;

for (const probe of ["inventory", "catalog-command", "version-gate"]) {
  test(
    `a finished ${probe} probe leaves no timeout keeping the daemon process alive`,
    async () => {
      expect(await processLifetimeMs(probe)).toBeLessThan(PROBE_TIMEOUT_MS);
    },
    TEST_TIMEOUT_MS,
  );
}

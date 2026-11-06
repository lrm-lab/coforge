import { expect, test } from "bun:test";
import { join } from "node:path";

// range-checks.ts is the --range entrypoint ci.yml and pre-push share: it must return
// the hard rules' verdict while still running the warn-only Reviewed-in pass.
test("bad input exits with the hard rules' code 2", () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "range-checks.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
});

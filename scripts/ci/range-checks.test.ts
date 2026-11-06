import { expect, test } from "bun:test";
import { join } from "node:path";
import { useTestRepo } from "../git-hooks/test-repo";

// range-checks.ts is the --range entrypoint ci.yml and pre-push share: it must return
// the hard rules' verdict while still running the warn-only Reviewed-in pass, and it
// must add the whitespace check's failures on top (task #628).
const repo = useTestRepo();
const entrypoint = join(import.meta.dir, "range-checks.ts");
const range = (base: string, head = "HEAD") =>
  repo.run([process.execPath, entrypoint, "--range", base, head]);

test("bad input exits with the hard rules' code 2", () => {
  const result = Bun.spawnSync([process.execPath, entrypoint], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
});

test("a whitespace violation the hard rules pass still fails the entrypoint", () => {
  const base = repo.seed({ "a.txt": "a\n" });
  repo.seed({ "bad.txt": "line\n\n" });

  const result = range(base);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("bad.txt");
});

test("a clean range exits 0", () => {
  const base = repo.seed({ "a.txt": "a\n" });
  repo.seed({ "b.txt": "b\n" });

  expect(range(base)).toMatchObject({ exitCode: 0 });
});

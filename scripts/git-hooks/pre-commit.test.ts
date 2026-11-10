import { expect, spyOn, test } from "bun:test";

import { checkOxfmtAvailable } from "../ci/staged-format";
import { useTestRepo } from "./test-repo";

const repo = useTestRepo();
const formatted = "const value = { ok: true };\n";
const unformatted = "const value={ok:true};\n";

test("pre-commit checks the staged blob, not the worktree file", () => {
  repo.seed({ "apps/web/src.ts": formatted });
  const before = repo.head();
  repo.write({ "apps/web/src.ts": unformatted });
  repo.ok("add", "apps/web/src.ts");
  repo.write({ "apps/web/src.ts": formatted });

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("staged files are not formatted");
  expect(repo.head()).toBe(before);
});

test("a formatted staged blob passes even when the worktree is now different", () => {
  repo.seed({ "apps/web/src.ts": unformatted });
  repo.write({ "apps/web/src.ts": formatted });
  repo.ok("add", "apps/web/src.ts");
  repo.write({ "apps/web/src.ts": unformatted });

  expect(repo.commit().exitCode).toBe(0);
});

test("a missing formatter fails with an actionable no-bypass message", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const unavailable = checkOxfmtAvailable((() => ({
      exitCode: 1,
      stderr: Buffer.from("not found"),
    })) as typeof Bun.spawnSync);
    expect(unavailable).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Do not use --no-verify"));
  } finally {
    error.mockRestore();
  }
});

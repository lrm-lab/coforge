import { describe, expect, test } from "bun:test";
import { E2E_FLOWS, e2eFlowOf, e2eFlowProblem, rangeE2eFlowViolations } from "./e2e-flow";
import { useTestRepo } from "../git-hooks/test-repo";

const repo = useTestRepo();
const E2E = "apps/web/test/e2e-new-screen.e2e.ts";

describe("the E2E-Flow trailer", () => {
  test("names one of the key flows, and nothing else", () => {
    for (const flow of Object.keys(E2E_FLOWS))
      expect(e2eFlowOf(`test: x\n\nE2E-Flow: ${flow}\n`)).toBe(flow as keyof typeof E2E_FLOWS);
    expect(e2eFlowOf("test: x\n\nE2E-Flow: layout\n")).toBeUndefined();
    expect(e2eFlowOf("test: x\n\nE2E-Flow:\n")).toBeUndefined();
    expect(e2eFlowOf("test: x\n")).toBeUndefined();
  });

  test("is needed only by a commit that adds a browser e2e", () => {
    expect(e2eFlowProblem("test: x\n", ["apps/web/test/thing.integration.ts"])).toBeUndefined();
    expect(e2eFlowProblem("test: x\n", ["apps/web/src/a.e2e.ts"])).toBeUndefined();
    expect(e2eFlowProblem("test: x\n", [E2E])).toBe(`no E2E-Flow trailer for new ${E2E}`);
    expect(e2eFlowProblem("test: x\n\nE2E-Flow: spacing\n", [E2E])).toBe(
      `E2E-Flow \`spacing\` is not a key flow for new ${E2E}`,
    );
    expect(e2eFlowProblem("test: x\n\nE2E-Flow: messaging\n", [E2E])).toBeUndefined();
  });
});

describe("range and hook", () => {
  const commit = (...message: string[]) =>
    repo.ok("commit", "-q", "--no-verify", ...message.flatMap((part) => ["-m", part]));

  test("range mode flags a new e2e without a key flow, and passes edits and renames", () => {
    const base = repo.seed({ "a.txt": "one\n" });
    repo.write({ [E2E]: "export const a = 1;\n" });
    repo.ok("add", "-A");
    commit("test: a screen", "Revert-effect: none");
    const added = repo.head();
    repo.write({ [E2E]: "export const a = 2;\n" });
    repo.ok("add", "-A");
    commit("test: edit it", "Revert-effect: none");
    repo.ok("mv", E2E, "apps/web/test/e2e-renamed.e2e.ts");
    commit("refactor: rename it", "Revert-effect: none");

    const violations = rangeE2eFlowViolations(base, repo.head(), repo.dir);
    expect(violations).toEqual([
      { sha: added.slice(0, 9), found: `no E2E-Flow trailer for new ${E2E}` },
    ]);
    const result = repo.range(base, repo.head());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("e2e-flow");
    expect(result.stderr).toContain("E2E-Flow: <flow>");
  });

  test("a key flow passes the range", () => {
    const base = repo.seed({ "a.txt": "one\n" });
    repo.write({ [E2E]: "export {};\n" });
    repo.ok("add", "-A");
    commit("test: sending a message", "Revert-effect: none", "E2E-Flow: messaging");
    expect(rangeE2eFlowViolations(base, repo.head(), repo.dir)).toEqual([]);
  });

  test("the commit-msg hook refuses a new e2e without a key flow", () => {
    repo.seed({ "a.txt": "one\n" });
    repo.write({ [E2E]: "export {};\n" });
    repo.ok("add", "-A");
    const bad = repo.run([
      "git",
      "commit",
      "-q",
      "-m",
      "test: a screen",
      "-m",
      "Revert-effect: none",
    ]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("no E2E-Flow trailer");
    const good = repo.run([
      "git",
      "commit",
      "-q",
      "-m",
      "test: a sign-in path",
      "-m",
      "Revert-effect: none\nE2E-Flow: sign-in",
    ]);
    expect(good.exitCode).toBe(0);
  });
});

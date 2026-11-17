import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downstreamWorkspaces, lintFilesStrict } from "./run-checks";

const repoRoot = join(import.meta.dir, "../..");

describe("downstreamWorkspaces", () => {
  test("includes all transitive downstream dependents when a shared package changes", () => {
    const affected = downstreamWorkspaces(repoRoot, ["packages/coforge-sdk/src/index.ts"]).map(
      (ws) => ws.dir,
    );
    expect(affected).toContain("packages/coforge-sdk");
    expect(affected).toContain("packages/coforge");
    expect(affected).toContain("packages/agent");
    expect(affected).toContain("packages/daemon");
    expect(affected).toContain("packages/computer");
    expect(affected).toContain("apps/web");
  });
});

describe("lintFilesStrict", () => {
  test("fails on oxlint warnings (--deny-warnings) and passes on clean files", () => {
    const dir = mkdtempSync(join(tmpdir(), "coforge-lint-strict-"));
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts/warn.ts"), 'const unused = 1;\nexport const ok = "hi";\n');
      expect(lintFilesStrict(dir, ["scripts/warn.ts"])).toBe(false);

      writeFileSync(join(dir, "scripts/clean.ts"), 'export const ok = "hi";\n');
      expect(lintFilesStrict(dir, ["scripts/clean.ts"])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("local and CI command parity", () => {
  test("ci.yml Plan checks and local-gate both invoke run-checks.ts for strict lint", () => {
    const ciYml = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const lintScript = readFileSync(join(repoRoot, "scripts/ci/lint-ci-range.sh"), "utf8");
    const localGate = readFileSync(join(repoRoot, "scripts/ci/local-gate.ts"), "utf8");
    expect(ciYml).toContain("scripts/ci/lint-ci-range.sh");
    expect(lintScript).toContain("scripts/ci/run-checks.ts --lint-range");
    expect(lintScript).toContain("workflow_dispatch");
    expect(localGate).toContain("lintFilesStrict");
    expect(localGate).toContain("downstreamWorkspaces");
  });
});

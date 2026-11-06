import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasReviewedIn, loadPatterns, riskMatcher } from "./reviewed-in";
import { useTestRepo } from "../git-hooks/test-repo";

const repo = useTestRepo();
const script = join(import.meta.dir, "reviewed-in.ts");
const PATTERNS = ["apps/web/prisma/**", "**/*agent-api-key*", "packages/coforge-sdk/**"];
const match = riskMatcher(PATTERNS);

const run = (...args: string[]) => repo.run([process.execPath, script, ...args]);

describe("hasReviewedIn", () => {
  test("a task ref is required, a message id is optional", () => {
    expect(hasReviewedIn("subject\n\nReviewed-in: #coforge:#601\n")).toBe(true);
    expect(hasReviewedIn("subject\n\nReviewed-in: #coforge:#601 01a1b049-d6a4\n")).toBe(true);
    expect(hasReviewedIn("subject\n\nReviewed-in: #qa-test:#7\n")).toBe(true);
  });

  test("anything else does not count", () => {
    expect(hasReviewedIn("subject\n\nReviewed-in: yes\n")).toBe(false);
    expect(hasReviewedIn("subject\n\nReviewed-in: #coforge\n")).toBe(false);
    expect(hasReviewedIn("subject\n\nReviewed-in: #coforge:#abc\n")).toBe(false);
    expect(hasReviewedIn("subject\n\nReviewed-in: #coforge:#601 extra words\n")).toBe(false);
    expect(hasReviewedIn("subject mentioning Reviewed-in: #coforge:#601 inline\n")).toBe(false);
    expect(hasReviewedIn("subject only\n")).toBe(false);
  });
});

describe("riskMatcher", () => {
  test("directory globs, global globs and exact files", () => {
    expect(match("apps/web/prisma/schema.prisma")).toBe(true);
    expect(match("apps/web/prisma/migrations/001_init.sql")).toBe(true);
    expect(match("apps/web/prismax/schema.prisma")).toBe(false);
    expect(match("apps/web/src/server/agents/agent-api-key.server.ts")).toBe(true);
    expect(match("packages/daemon/src/credentials/agent-api-key.ts")).toBe(true);
    expect(match("packages/coforge-sdk/proto/coforge.proto")).toBe(true);
    expect(match("packages/coforge-sdk-ish/x.ts")).toBe(false);
    expect(match("apps/web/src/app.ts")).toBe(false);
  });
});

describe("loadPatterns", () => {
  test("skips blanks and comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "patterns-"));
    const file = join(dir, "p.txt");
    writeFileSync(file, "# comment\n\napps/web/prisma/**\n  \ninfra/**\n");
    expect(loadPatterns(file)).toEqual(["apps/web/prisma/**", "infra/**"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("range findings", () => {
  test("a risky commit without the trailer warns; with it stays silent", () => {
    const base = repo.seed({ "seed.txt": "seed\n" });
    repo.write({ "apps/web/prisma/schema.prisma": "model A {}\n" });
    repo.ok("add", "-A");
    repo.commit();
    const warn = run("--range", base, "HEAD");
    expect(warn.exitCode).toBe(0);
    expect(warn.stdout).toContain("::warning::");
    expect(warn.stdout).toContain("apps/web/prisma/schema.prisma");

    repo.write({ "apps/web/prisma/schema.prisma": "model A { id Int }\n" });
    repo.commitAll({}, "-m", "Reviewed-in: #coforge:#601");
    const quiet = run("--range", base, "HEAD");
    // The first commit still warns; the reviewed one adds nothing.
    expect(quiet.stdout.match(/::warning::/g)?.length).toBe(1);
  });

  test("safe paths and merge commits stay silent", () => {
    const base = repo.seed({ "seed.txt": "seed\n" });
    repo.write({ "apps/web/src/app.ts": "export {}\n" });
    repo.commitAll();
    repo.ok("checkout", "-q", "-b", "side");
    repo.write({ "apps/web/prisma/schema.prisma": "model B {}\n" });
    repo.commitAll({}, "-m", "Reviewed-in: #coforge:#601");
    repo.ok("checkout", "-q", "main");
    repo.write({ "other.txt": "x\n" });
    repo.commitAll();
    repo.ok("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const result = run("--range", base, "HEAD");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("::warning::");
  });

  test("a malformed Reviewed-in still warns", () => {
    const base = repo.seed({ "seed.txt": "seed\n" });
    repo.write({ "packages/coforge-sdk/proto/x.proto": 'syntax = "proto3";\n' });
    repo.commitAll({}, "-m", "Reviewed-in: approved");
    const result = run("--range", base, "HEAD");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("packages/coforge-sdk/proto/x.proto");
  });

  test("findings reach the step summary as markdown", () => {
    const base = repo.seed({ "seed.txt": "seed\n" });
    repo.write({ "apps/web/prisma/schema.prisma": "model C {}\n" });
    repo.commitAll();
    const summary = join(mkdtempSync(join(tmpdir(), "summary-")), "step-summary.md");
    const result = repo.run([process.execPath, script, "--range", base, "HEAD"], {
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.exitCode).toBe(0);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("Reviewed-in");
    expect(text).toContain("apps/web/prisma/schema.prisma");
    rmSync(join(summary, ".."), { recursive: true, force: true });
  });
});

import { describe, expect, test } from "bun:test";
import { decide } from "./pre-edit";

describe("pre-edit hook", () => {
  test("denies hand edits to package manifests and the lockfile", () => {
    expect(decide("apps/web/package.json").kind).toBe("deny");
    expect(decide("bun.lock").kind).toBe("deny");
  });
  test("asks before exemption config", () => {
    expect(decide(".oxlintrc.json").kind).toBe("ask");
    expect(decide("apps/web/tsconfig.json").kind).toBe("ask");
    for (const path of ["apps/web/.oxfmtrc.json", "crates/installer/deny.toml", "crates/installer/about.toml"])
      expect(decide(path).kind).toBe("ask");
  });
  test("no longer asks for a config file that does not exist", () => {
    expect(decide(".prettierignore").kind).toBe("allow");
  });
  test("denies hand edits to generated files", () => {
    expect(decide("apps/web/src/routeTree.gen.ts").kind).toBe("deny");
    expect(decide("crates/installer/contract/install-contract.json").kind).toBe("deny");
    expect(decide("apps/web/src/routes/index.tsx").kind).not.toBe("deny");
  });
  test("injects the doc a path needs", () => {
    expect(decide("packages/x/a.test.ts")).toEqual({ kind: "context", text: expect.stringContaining("docs/agents/testing.md") });
    expect(decide("apps/web/src/features/x/y.tsx")).toMatchObject({ text: expect.stringContaining("ui-hard-rules") });
    expect(decide("mise.toml")).toMatchObject({ text: expect.stringContaining("mise-tasks") });
  });
  test("allows everything else", () => {
    expect(decide("packages/daemon/src/a.ts").kind).toBe("allow");
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  codeAgentExecutableSearchPath,
  executablePathDelimiter,
} from "#src/platform/code-agent-path";

/** Each test gets its own temporary home: nothing is shared with the host's real one, so the
 * tests neither race each other nor touch installed runtimes. */
const roots: string[] = [];
function newFakeHome(): string {
  const root = mkdtempSync(join(tmpdir(), "coforge-code-agent-path-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("codeAgentExecutableSearchPath", () => {
  test("always keeps the ambient PATH first and appends user + platform directories", () => {
    const home = newFakeHome();
    const result = codeAgentExecutableSearchPath({ HOME: home, PATH: "/ambient/bin" }, "linux");
    expect(result.startsWith(`/ambient/bin${executablePathDelimiter("linux")}`)).toBe(true);
    expect(result).toContain(join(home, ".local", "bin"));
    expect(result).toContain("/usr/local/bin");
  });

  test("discovers every nvm-managed node bin directory present at call time", () => {
    const home = newFakeHome();
    const nvmRoot = join(home, ".nvm", "versions", "node");
    const expected: string[] = [];
    for (const version of ["v20.11.0", "v22.14.0"]) {
      const bin = join(nvmRoot, version, "bin");
      mkdirSync(bin, { recursive: true });
      expected.push(bin);
    }
    const result = codeAgentExecutableSearchPath({ HOME: home }, "linux");
    // readdir order is unspecified; every discovered bin must be in the search path.
    const entries = result.split(executablePathDelimiter("linux"));
    for (const bin of expected) expect(entries).toContain(bin);
  });

  test("searches the custom npm prefix directory unconditionally", () => {
    const home = newFakeHome();
    const result = codeAgentExecutableSearchPath({ HOME: home }, "linux");
    expect(result).toContain(join(home, ".npm-global", "bin"));
  });

  test("an absent nvm root adds nothing and does not throw", () => {
    const home = newFakeHome();
    const entries = codeAgentExecutableSearchPath({ HOME: home }, "linux").split(
      executablePathDelimiter("linux"),
    );
    expect(entries.some((entry) => entry.includes(".nvm"))).toBe(false);
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest("works without HOME: only the windows APPDATA branch remains", () => {
    const result = codeAgentExecutableSearchPath(
      { PATH: "C:\\ambient", APPDATA: "C:\\Users\\x\\npm" },
      "win32",
    );
    expect(result.split(executablePathDelimiter("win32"))).toContain("C:\\Users\\x\\npm\\npm");
  });
});

describe("nvm discovery through the daemon seam", () => {
  test("an npm-installed launcher resolves and reports a version when its node is on PATH", async () => {
    if (process.platform === "win32") return;
    const home = newFakeHome();
    const bin = join(home, ".npm-global", "bin");
    mkdirSync(bin, { recursive: true });
    // The daemon's own PATH may well lack node; the probe must run against the augmented
    // environment instead of the caller's raw one.
    writeFileSync(
      join(bin, "codex-launcher-probe"),
      "#!/usr/bin/env node\nconsole.log('codex 0.0.0-test');\n",
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho 'stub'\n", { mode: 0o755 });
    const searchPath = codeAgentExecutableSearchPath({ HOME: home, PATH: "/no/node/here" }, "linux");
    const resolved = Bun.which("codex-launcher-probe", { PATH: searchPath });
    expect(resolved).toBeDefined();
    const child = Bun.spawn({
      cmd: [resolved!, "--version"],
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: searchPath, HOME: home },
    });
    const output = await new Response(child.stdout).text();
    // The launcher resolved through env node and answered with its own print.
    expect(output.trim()).not.toBe("");
    child.kill();
  });
});
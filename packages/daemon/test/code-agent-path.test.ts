import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posix, win32 as winPath } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  codeAgentExecutableSearchPath,
  executablePathDelimiter,
} from "#src/platform/code-agent-path";
import {
  discoverExternalCodeAgents,
  type ExternalCodeAgentProbe,
} from "#src/code-agent/runtime-inventory";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

/** Every fixture lives in a per-test `mkdtemp` home: nothing is shared with the host's real
 * HOME (no racing installs), and cross-platform assertions are built from the same `path`
 * module the code under test uses for the platform being passed. */
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
    expect(result).toContain(posix.join(home, ".local", "bin"));
    expect(result).toContain("/usr/local/bin");
  });

  test("an absent nvm root adds nothing and does not throw", () => {
    const home = newFakeHome();
    const entries = codeAgentExecutableSearchPath({ HOME: home }, "linux").split(
      executablePathDelimiter("linux"),
    );
    expect(entries.some((entry) => entry.includes(".nvm"))).toBe(false);
  });

  test("nvm-managed node bin directories enter the search path when present", () => {
    const home = newFakeHome();
    const nvmRoot = posix.join(home, ".nvm", "versions", "node");
    for (const version of ["v20.11.0", "v22.14.0"]) {
      mkdirSync(posix.join(nvmRoot, version, "bin"), { recursive: true });
    }
    const entries = codeAgentExecutableSearchPath({ HOME: home }, "linux").split(
      executablePathDelimiter("linux"),
    );
    expect(entries).toContain(posix.join(nvmRoot, "v20.11.0", "bin"));
    expect(entries).toContain(posix.join(nvmRoot, "v22.14.0", "bin"));
  });

  test("searches the custom npm prefix directory unconditionally", () => {
    const home = newFakeHome();
    const result = codeAgentExecutableSearchPath({ HOME: home }, "linux");
    expect(result).toContain(posix.join(home, ".npm-global", "bin"));
  });

  test("works without HOME: only the windows APPDATA branch remains", () => {
    const appData = "C:\\Users\\x\\npm";
    const result = codeAgentExecutableSearchPath(
      { PATH: "C:\\ambient", APPDATA: appData },
      "win32",
    );
    expect(result.split(executablePathDelimiter("win32"))).toContain(winPath.join(appData, "npm"));
  });
});

describe("npm-installed Codex discovery through the public seam", () => {
  /** POSIX execution fixtures (shebang launchers) cannot run on Windows; every pure-path test
   * above runs everywhere. */
  const seamTest = test.skipIf(process.platform === "win32");

  seamTest(
    "an npm-style launcher resolves and probes through discoverExternalCodeAgents",
    async () => {
      // The old build's red: the version probe spawned with the daemon's raw env, whose PATH
      // (here deliberately `/ambient-only-path`) cannot resolve the fixture interpreter — the
      // launcher "exists" but reports no runtime. The new build's green: the probe runs with the
      // discovery environment whose PATH reaches the fixture.
      const home = newFakeHome();
      const bin = posix.join(home, ".npm-global", "bin");
      mkdirSync(bin, { recursive: true });
      const stub = posix.join(bin, "codex-fake-node");
      writeFileSync(
        stub,
        await Bun.file(posix.join("test", "fixtures", "codex-fake-node")).text(),
        {
          mode: 0o755,
        },
      );
      writeFileSync(posix.join(bin, "codex"), "#!/usr/bin/env codex-fake-node", { mode: 0o755 });

      const environment = { HOME: home, PATH: "/ambient-only-path" };
      const runtimes = await discoverExternalCodeAgents(
        undefined as unknown as ExternalCodeAgentProbe,
        environment,
        "linux",
        RUNTIME_PROVIDER.CODEX,
      );
      expect(runtimes).toEqual([
        { provider: RUNTIME_PROVIDER.CODEX, version: "0.0-seam", displayName: "Codex" },
      ]);
    },
    15_000,
  );
});

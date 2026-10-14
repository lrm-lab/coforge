import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { posix, win32 as winPath } from "node:path";
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
import { CATALOG_DISCOVERY_BUDGET_MS } from "./catalog-discovery-budget";

/** Every fixture lives in a per-test `mkdtemp` home: nothing is shared with the host's real
 * HOME (no racing installs), and cross-platform assertions are built from the same `path`
 * module the code under test uses for the platform being passed. */
const roots: string[] = [];
function newFakeHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), "coforge-code-agent-path-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Filesystem-backed cases always run against the host platform: the fixtures are real
 * directories in a temp home, so the path module and delimiter must match what the code under
 * test resolves at runtime. Pure-string cases (the windows APPDATA branch) hardcode their own. */
const hostPlatform = process.platform;
const hostJoin = hostPlatform === "win32" ? winPath.join.bind(winPath) : posix.join.bind(posix);
const hostDelimiter = executablePathDelimiter(hostPlatform);

describe("codeAgentExecutableSearchPath", () => {
  test("always keeps the ambient PATH first and appends user + platform directories", () => {
    const home = newFakeHome();
    const paths = hostPlatform === "win32" ? winPath : posix;
    const ambient = paths.join(home, "ambient-bin");
    // On windows the npm-prefix directory only comes from APPDATA; pass it so the assertion
    // matches what this exact input produces.
    const environment: Record<string, string> = { HOME: home, PATH: ambient };
    if (hostPlatform === "win32") {
      environment.APPDATA = "C:\\Users\\x\\npm";
      expect(codeAgentExecutableSearchPath(environment, hostPlatform).split(hostDelimiter)).toContain(
        winPath.join(environment.APPDATA, "npm"),
      );
    } else {
      environment.APPDATA = home;
    }
    const result = codeAgentExecutableSearchPath(environment, hostPlatform);
    const directories = result.split(hostDelimiter);
    expect(directories[0]).toBe(ambient);
    expect(directories).toContain(hostJoin(home, ".local", "bin"));
    expect(result).toContain(
      hostPlatform === "win32" ? winPath.join(environment.APPDATA, "npm") : "/usr/local/bin",
    );
  });

  test("an absent nvm root adds nothing and does not throw", () => {
    const home = newFakeHome();
    const entries = codeAgentExecutableSearchPath({ HOME: home }, hostPlatform).split(
      hostDelimiter,
    );
    expect(entries.some((entry) => /\.nvm\b/.test(entry))).toBe(false);
  });

  test("nvm-managed node bin directories enter the search path when present", () => {
    const home = newFakeHome();
    const nvmRoot = hostJoin(home, ".nvm", "versions", "node");
    for (const version of ["v20.11.0", "v22.14.0"]) {
      mkdirSync(hostJoin(nvmRoot, version, "bin"), { recursive: true });
    }
    const entries = codeAgentExecutableSearchPath({ HOME: home }, hostPlatform).split(
      hostDelimiter,
    );
    expect(entries).toContain(hostJoin(nvmRoot, "v20.11.0", "bin"));
    expect(entries).toContain(hostJoin(nvmRoot, "v22.14.0", "bin"));
  });

  test("searches the custom npm prefix directory unconditionally", () => {
    const home = newFakeHome();
    const result = codeAgentExecutableSearchPath({ HOME: home }, hostPlatform);
    expect(result).toContain(hostJoin(home, ".npm-global", "bin"));
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
  /** Windows twin: `codex.cmd` -> `codex-fake-node.cmd` (resolved by the child's PATH, so the
   * property under test is the same). POSIX: shebang `codex` -> `codex-fake-node`. */
  async function writeCodexFixture(home: string) {
    const bin = hostJoin(home, ".npm-global", "bin");
    mkdirSync(bin, { recursive: true });
    if (hostPlatform === "win32") {
      writeFileSync(
        hostJoin(bin, "codex.cmd"),
        await Bun.file(path.join(import.meta.dir, "fixtures", "codex.cmd")).text(),
      );
      writeFileSync(
        hostJoin(bin, "codex-fake-node.cmd"),
        await Bun.file(path.join(import.meta.dir, "fixtures", "codex-fake-node.cmd")).text(),
      );
    } else {
      writeFileSync(hostJoin(bin, "codex"), "#!/usr/bin/env codex-fake-node", { mode: 0o755 });
      writeFileSync(
        hostJoin(bin, "codex-fake-node"),
        await Bun.file(path.join(import.meta.dir, "fixtures", "codex-fake-node")).text(),
        { mode: 0o755 },
      );
    }
    return bin;
  }

  test(
    "an npm-style launcher resolves and probes through discoverExternalCodeAgents",
    async () => {
      // The old build's red: the version probe spawned with the daemon's raw env, whose PATH
      // (here deliberately `/ambient-only-path`) cannot resolve the fixture interpreter — the
      // launcher "exists" but reports no runtime. The new build's green: the probe runs with the
      // discovery environment whose PATH reaches the fixture.
      const home = newFakeHome();
      await writeCodexFixture(home);

      const environment = { HOME: home, PATH: "/ambient-only-path" };
      const runtimes = await discoverExternalCodeAgents(
        undefined as unknown as ExternalCodeAgentProbe,
        environment,
        process.platform,
        RUNTIME_PROVIDER.CODEX,
      );
      expect(runtimes).toEqual([
        { provider: RUNTIME_PROVIDER.CODEX, version: "0.0-seam", displayName: "Codex" },
      ]);
    },
    CATALOG_DISCOVERY_BUDGET_MS + 5_000,
  );
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  codeAgentExecutableSearchPath,
  executablePathDelimiter,
} from "#src/platform/code-agent-path";

const fakeHome = join(homedir(), ".coforge-test-code-agent-path");

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function fakeEnvironment(paths?: string) {
  return paths ? { HOME: fakeHome, PATH: paths } : { HOME: fakeHome };
}

describe("codeAgentExecutableSearchPath", () => {
  test("always keeps the ambient PATH first and appends user + platform directories", () => {
    const result = codeAgentExecutableSearchPath(fakeEnvironment("/ambient/bin"));
    expect(result.startsWith("/ambient/bin:")).toBe(true);
    expect(result).toContain(`${fakeHome}/.local/bin`);
    expect(result).toContain("/usr/local/bin");
  });

  test("discovers every nvm-managed node bin directory, newest install included", () => {
    const nvmRoot = join(fakeHome, ".nvm", "versions", "node");
    for (const version of ["v20.11.0", "v22.14.0"]) {
      mkdirSync(join(nvmRoot, version, "bin"), { recursive: true });
    }
    const result = codeAgentExecutableSearchPath(fakeEnvironment());
    expect(result).toContain(join(nvmRoot, "v20.11.0", "bin"));
    expect(result).toContain(join(nvmRoot, "v22.14.0", "bin"));
    const positions = [result.indexOf("v20.11.0"), result.indexOf("v22.14.0")] as const;
    expect(positions[0]!).toBeLessThan(positions[1]!);
  });

  test("always searches a custom npm prefix directory", () => {
    const result = codeAgentExecutableSearchPath(fakeEnvironment());
    expect(result).toContain(`${fakeHome}/.npm-global/bin`);
  });

  test("works without HOME: only the windows APPDATA branch remains", () => {
    const result = codeAgentExecutableSearchPath(
      { PATH: "C:\\ambient", APPDATA: "C:\\Users\\x\\npm" },
      "win32",
    );
    expect(result.split(executablePathDelimiter("win32"))).toContain("C:\\Users\\x\\npm\\npm");
  });
});

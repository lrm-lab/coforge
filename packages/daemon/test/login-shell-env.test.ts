import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { boundedLoginShellEnv, isLoginShellEnvAllowed } from "#src/platform/login-shell-env";
import { writeLoginShellPathProbe } from "#src/platform/login-shell-path";
import {
  LOGIN_SHELL_PATH_FILE,
  readLoginShellPath,
  writeLoginShellPath,
} from "#src/platform/login-shell-path-state";
import { captureLoginShellEnvironment } from "#src/daemon-runtime/login-shell-env";

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "coforge-login-env-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ENV_NAMES = [
  "AIBERM_API_KEY",
  "DEEPSEEK_API_KEY",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "OPENAI_API_KEY",
  "MY_APP_CREDENTIALS",
  "HTTP_PROXY",
  "https_proxy",
  "NO_PROXY",
  "LANG",
  "LC_ALL",
  "LC_TIME",
];

describe("isLoginShellEnvAllowed", () => {
  test("allows credential-shaped, proxy and locale names", () => {
    for (const name of ENV_NAMES) expect(isLoginShellEnvAllowed(name)).toBe(true);
  });

  test("denies CoForge-injected, system and arbitrary names", () => {
    for (const name of [
      "COFORGE_DAEMON_API_KEY",
      "COFORGE_SUPERVISOR_SOCKET",
      "DATABASE_URL",
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      "HOME",
      "PATH",
      "SHELL",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "BASH_ENV",
      "AWS_REGION",
      "EDITOR",
      "CUSTOM_VAR",
    ])
      expect(isLoginShellEnvAllowed(name)).toBe(false);
  });
});

describe("boundedLoginShellEnv", () => {
  test("keeps only defined allowlisted entries", () => {
    expect(
      boundedLoginShellEnv({
        TEST_PROVIDER_API_KEY: "k",
        DATABASE_URL: "postgres://x",
        EMPTY: undefined,
        HTTP_PROXY: "http://p",
      }),
    ).toEqual({ TEST_PROVIDER_API_KEY: "k", HTTP_PROXY: "http://p" });
  });

  test("drops an oversized env whole instead of risking the PATH result", () => {
    const huge = "x".repeat(200 * 1024);
    expect(boundedLoginShellEnv({ TEST_PROVIDER_API_KEY: huge })).toEqual({});
  });
});

describe("writeLoginShellPathProbe", () => {
  test("writes the filtered env next to the PATH for the probing parent", async () => {
    const dir = newRoot();
    const file = path.join(dir, "result.json");
    await writeLoginShellPathProbe(file, "nonce-1", {
      PATH: "/a:/b",
      TEST_PROVIDER_API_KEY: "k",
      DATABASE_URL: "postgres://x",
      COFORGE_DAEMON_API_KEY: "c",
    });
    const parsed = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
    expect(parsed).toEqual({
      nonce: "nonce-1",
      path: "/a:/b",
      env: { TEST_PROVIDER_API_KEY: "k" },
    });
  });
});

describe("writeLoginShellPath", () => {
  test("never persists the captured env", async () => {
    const dir = newRoot();
    await writeLoginShellPath(dir, {
      ok: true,
      path: ["/opt/one"],
      env: { TEST_PROVIDER_API_KEY: "k" },
      shell: "/bin/zsh",
      durationMs: 3,
    });
    const raw = await Bun.file(path.join(dir, LOGIN_SHELL_PATH_FILE)).text();
    expect(raw).not.toContain("TEST_PROVIDER_API_KEY");
    expect(raw).not.toContain('"env"');
    expect(readLoginShellPath(dir)).toMatchObject({ ok: true, path: ["/opt/one"] });
  });
});

describe("captureLoginShellEnvironment", () => {
  const touched = ["TEST_PROVIDER_API_KEY", "COFORGE_TEST_MARK", "EXISTING_API_KEY"];
  afterEach(() => {
    for (const name of touched) delete process.env[name];
  });

  test("fills absent allowlisted variables and keeps existing ones", async () => {
    process.env.EXISTING_API_KEY = "mine";
    const databaseUrlBefore = process.env.DATABASE_URL;
    const result = await captureLoginShellEnvironment({
      probe: async () => ({
        ok: true,
        path: ["/opt/one"],
        env: {
          TEST_PROVIDER_API_KEY: "from-shell",
          EXISTING_API_KEY: "from-shell",
          COFORGE_TEST_MARK: "smuggled",
          DATABASE_URL: "smuggled",
        },
        shell: "/bin/zsh",
        durationMs: 1,
      }),
    });
    expect(process.env.TEST_PROVIDER_API_KEY).toBe("from-shell");
    expect(process.env.EXISTING_API_KEY).toBe("mine");
    expect(process.env.COFORGE_TEST_MARK).toBeUndefined();
    expect(process.env.DATABASE_URL).toBe(databaseUrlBefore);
    expect(result).toEqual({ imported: 1, kept: 1 });
  });

  test("a failed probe changes nothing", async () => {
    process.env.TEST_PROVIDER_API_KEY = "before";
    const result = await captureLoginShellEnvironment({
      probe: async () => ({ ok: false, reason: "timeout", durationMs: 1 }),
    });
    expect(result).toBeUndefined();
    expect(process.env.TEST_PROVIDER_API_KEY).toBe("before");
  });
});

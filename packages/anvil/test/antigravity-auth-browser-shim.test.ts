import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityRuntimeAuthAdapter,
  type AntigravityAuthHost,
} from "@lrm/coforge-anvil/antigravity";
import type { RuntimeAuthLoginEvent } from "@lrm/coforge-anvil";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname;

function headlessAuthHost(cwd: string, env: Record<string, string>): AntigravityAuthHost {
  return {
    command: [process.execPath, FIXTURE],
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...env,
      AGY_ACP_FIXTURE_LOG: join(cwd, "rpc.jsonl"),
      AGY_ACP_FIXTURE_STATE: join(cwd, "state.txt"),
    },
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    clientInfo: { name: "agy-acp-fixture", version: "1" },
    canOpenBrowser: false,
    stateDirectory: cwd,
    maskAccountLabel: (value) => (value.includes("@") ? "u****@example.com" : undefined),
  };
}

test("headless login captures a Google OAuth URL launched via xdg-open when stdout omits it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-shim-"));
  let shimDir: string | undefined;
  try {
    const base = headlessAuthHost(dir, {
      AGY_ACP_FIXTURE_SIGNED_OUT: "1",
      AGY_ACP_FIXTURE_LOGIN_NO_URL: "1",
      AGY_ACP_FIXTURE_LOGIN_USE_BROWSER: "xdg-open",
    });
    const baseSpawn = base.processTreeSpawner.spawn.bind(base.processTreeSpawner);
    const host: AntigravityAuthHost = {
      ...base,
      processTreeSpawner: {
        spawn: (command, cwd, env) => {
          if (command.includes("--login")) shimDir = env.PATH?.split(":")[0];
          return baseSpawn(command, cwd, env);
        },
      },
    };
    const events: RuntimeAuthLoginEvent[] = [];
    const adapter = new AntigravityRuntimeAuthAdapter(host);
    const result = await adapter.startLogin(
      { workingDirectory: dir },
      {
        onEvent: (event) => events.push(event),
        prompt: async () => "valid-oauth-code",
      },
    );
    expect(result).toMatchObject({ status: "logged_in" });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "auth_url",
        verificationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=fixture&state=s",
      }),
    );
    expect(shimDir).toBeDefined();
    expect(existsSync(shimDir!)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless login captures a Google OAuth URL launched via $BROWSER and rejects untrusted URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-shim-untrusted-"));
  try {
    const okEvents: RuntimeAuthLoginEvent[] = [];
    const okAdapter = new AntigravityRuntimeAuthAdapter(
      headlessAuthHost(dir, {
        AGY_ACP_FIXTURE_SIGNED_OUT: "1",
        AGY_ACP_FIXTURE_LOGIN_NO_URL: "1",
        AGY_ACP_FIXTURE_LOGIN_USE_BROWSER: "browser",
      }),
    );
    const okResult = await okAdapter.startLogin(
      { workingDirectory: dir },
      {
        onEvent: (event) => okEvents.push(event),
        prompt: async () => "valid-oauth-code",
      },
    );
    expect(okResult.status).toBe("logged_in");
    expect(okEvents.some((event) => event.kind === "auth_url")).toBe(true);

    const badEvents: RuntimeAuthLoginEvent[] = [];
    const badAdapter = new AntigravityRuntimeAuthAdapter(
      headlessAuthHost(dir, {
        AGY_ACP_FIXTURE_SIGNED_OUT: "1",
        AGY_ACP_FIXTURE_LOGIN_NO_URL: "1",
        AGY_ACP_FIXTURE_LOGIN_USE_BROWSER: "xdg-open",
        AGY_ACP_FIXTURE_LOGIN_URL: "https://evil.example.com/phish",
      }),
    );
    const badResult = await badAdapter.startLogin(
      { workingDirectory: dir },
      {
        onEvent: (event) => badEvents.push(event),
        prompt: async () => "unused",
      },
    );
    expect(badResult.status).toBe("failed");
    expect(badEvents.some((event) => event.kind === "auth_url")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityRuntimeAuthAdapter,
  type AntigravityAuthHost,
} from "@lrm/coforge-anvil/antigravity";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname;

function authHost(
  cwd: string,
  env: Record<string, string> = {},
  canOpenBrowser = true,
): AntigravityAuthHost {
  return {
    command: [process.execPath, FIXTURE],
    environment: {
      ...env,
      AGY_ACP_FIXTURE_LOG: join(cwd, "rpc.jsonl"),
      AGY_ACP_FIXTURE_STATE: join(cwd, "state.txt"),
    },
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    clientInfo: { name: "agy-acp-fixture", version: "1" },
    canOpenBrowser,
    stateDirectory: cwd,
    maskAccountLabel: (value) => (value.includes("@") ? "u****@example.com" : undefined),
  };
}

async function cwd() {
  return mkdtemp(join(tmpdir(), "agy-auth-"));
}

test("a signed-out status read returns logged_out through session/new -32000", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(dir, { AGY_ACP_FIXTURE_SIGNED_OUT: "1" }),
    );
    const status = await adapter.readStatus({ workingDirectory: dir });
    expect(status).toEqual({ provider: "antigravity", state: "logged_out" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a signed-in status read returns logged_in", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(authHost(dir));
    const status = await adapter.readStatus({ workingDirectory: dir });
    expect(status.state).toBe("logged_in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a completed authenticate signs the status read in", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(authHost(dir));
    const events: string[] = [];
    const result = await adapter.startLogin(
      { workingDirectory: dir, antigravityMethodId: "oauth-business" },
      {
        onEvent: (event) => events.push(event.kind),
        prompt: async () => "",
      },
    );
    expect(result.status).toBe("logged_in");
    expect(events).toContain("info");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cancelled authenticate returns cancelled, never a failure", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(dir, { AGY_ACP_FIXTURE_AUTH_CANCEL: "1" }),
    );
    const result = await adapter.startLogin(
      { workingDirectory: dir },
      { onEvent: () => {}, prompt: async () => "" },
    );
    expect(result.status).toBe("cancelled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an aborted login disposes the auth process", async () => {
  const dir = await cwd();
  const spawned: { exited: Promise<number> }[] = [];
  try {
    const host = authHost(dir, { AGY_ACP_FIXTURE_AUTH_HANG: "1" });
    const baseSpawn = host.processTreeSpawner.spawn.bind(host.processTreeSpawner);
    host.processTreeSpawner = {
      ...host.processTreeSpawner,
      spawn: (...args: Parameters<typeof baseSpawn>) => {
        const child = baseSpawn(...args);
        spawned.push(child.child as { exited: Promise<number> });
        return child;
      },
    };
    const adapter = new AntigravityRuntimeAuthAdapter(host);
    const controller = new AbortController();
    const result = adapter.startLogin(
      { workingDirectory: dir, timeoutMs: 120_000 },
      { onEvent: () => {}, prompt: async () => "", signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    expect(await result).toEqual(expect.objectContaining({ status: "cancelled" }));
    expect(spawned).toHaveLength(1);
    await expect(spawned[0]!.exited).resolves.toBeGreaterThanOrEqual(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a headless business login is refused before any process spawns", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(authHost(dir, {}, false));
    const result = await adapter.startLogin(
      { workingDirectory: dir, antigravityMethodId: "oauth-business" },
      { onEvent: () => {}, prompt: async () => "" },
    );
    expect(result.status).toBe("failed");
    expect((result as { detail?: string }).detail).toMatch(/desktop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a headless personal login runs agy acp --login and signs the status read in", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(dir, { AGY_ACP_FIXTURE_SIGNED_OUT: "1" }, false),
    );
    const events: { kind: string; verificationUrl?: string }[] = [];
    const prompts: string[] = [];
    const secrets: string[] = [];
    const result = await adapter.startLogin(
      { workingDirectory: dir, onSecret: (secret) => secrets.push(secret) },
      {
        onEvent: (event) => events.push(event),
        prompt: async ({ message }) => {
          prompts.push(message ?? "");
          return "4/fixture-code";
        },
      },
    );
    expect(result.status).toBe("logged_in");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "auth_url",
        verificationUrl: expect.stringContaining("accounts.google.com"),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: "code_prompt" }));
    expect(prompts.length).toBeGreaterThan(0);
    expect(secrets).toContain("4/fixture-code");
    const status = await adapter.readStatus({ workingDirectory: dir });
    expect(status.state).toBe("logged_in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a headless login refuses a sign-in link that is not a Google address", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(
        dir,
        {
          AGY_ACP_FIXTURE_SIGNED_OUT: "1",
          AGY_ACP_FIXTURE_LOGIN_URL: "https://evil.example.com/o/oauth2/auth",
        },
        false,
      ),
    );
    const result = await adapter.startLogin(
      { workingDirectory: dir },
      { onEvent: () => {}, prompt: async () => "4/fixture-code" },
    );
    expect(result).toEqual(expect.objectContaining({ status: "failed", reason: "process_failed" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a headless login on an agy without --login asks for an upgrade", async () => {
  const dir = await cwd();
  const spawned: string[][] = [];
  try {
    const host = authHost(dir, { AGY_ACP_FIXTURE_NO_LOGIN_FLAG: "1" }, false);
    const baseSpawn = host.processTreeSpawner.spawn.bind(host.processTreeSpawner);
    host.processTreeSpawner = {
      ...host.processTreeSpawner,
      spawn: (...args: Parameters<typeof baseSpawn>) => {
        spawned.push([...args[0]]);
        return baseSpawn(...args);
      },
    };
    const adapter = new AntigravityRuntimeAuthAdapter(host);
    const result = await adapter.startLogin(
      { workingDirectory: dir },
      { onEvent: () => {}, prompt: async () => "" },
    );
    expect(result).toEqual(
      expect.objectContaining({ status: "unsupported", reason: "version_unsupported" }),
    );
    // Only the --help probe ran; no --login child was ever spawned.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("--help");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a headless login that agy rejects reports rejected, not a crash", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(dir, { AGY_ACP_FIXTURE_SIGNED_OUT: "1", AGY_ACP_FIXTURE_LOGIN_REJECT: "1" }, false),
    );
    const result = await adapter.startLogin(
      { workingDirectory: dir },
      { onEvent: () => {}, prompt: async () => "bad-code" },
    );
    expect(result).toEqual(expect.objectContaining({ status: "failed", reason: "rejected" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a headless login prompt with no link fails instead of waiting forever", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(dir, { AGY_ACP_FIXTURE_SIGNED_OUT: "1", AGY_ACP_FIXTURE_LOGIN_NO_URL: "1" }, false),
    );
    const result = await adapter.startLogin(
      { workingDirectory: dir, timeoutMs: 30_000 },
      { onEvent: () => {}, prompt: async () => "4/fixture-code" },
    );
    expect(result).toEqual(expect.objectContaining({ status: "failed", reason: "process_failed" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a headless login hangs are bounded by the timeout and by abort", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(dir, { AGY_ACP_FIXTURE_LOGIN_HANG: "1" }, false),
    );
    const never = () => new Promise<string>(() => {});
    const timedOut = await adapter.startLogin(
      { workingDirectory: dir, timeoutMs: 500 },
      { onEvent: () => {}, prompt: never },
    );
    expect(timedOut).toEqual(expect.objectContaining({ status: "failed", reason: "timed_out" }));
    const controller = new AbortController();
    const pending = adapter.startLogin(
      { workingDirectory: dir, timeoutMs: 120_000 },
      { onEvent: () => {}, prompt: never, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    expect(await pending).toEqual({ status: "cancelled" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logout flips the server to signed-out inside the same process", async () => {
  const dir = await cwd();
  try {
    // No SIGNED_OUT env: the fixture starts signed in, `logout` is what flips it, and the
    // post-logout `session/new` probe meets `-32000` on the same transport.
    const adapter = new AntigravityRuntimeAuthAdapter(authHost(dir));
    const result = await adapter.logout({ workingDirectory: dir });
    expect(result.status).toBe("logged_out");
    const status = await adapter.readStatus({ workingDirectory: dir });
    expect(status.state).toBe("logged_out");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a timed-out login kills the auth process before it reports", async () => {
  const dir = await cwd();
  const spawned: { exited: Promise<number> }[] = [];
  try {
    const host = authHost(dir, { AGY_ACP_FIXTURE_AUTH_HANG: "1" });
    const baseSpawn = host.processTreeSpawner.spawn.bind(host.processTreeSpawner);
    host.processTreeSpawner = {
      ...host.processTreeSpawner,
      spawn: (...args: Parameters<typeof baseSpawn>) => {
        const child = baseSpawn(...args);
        spawned.push(child.child as { exited: Promise<number> });
        return child;
      },
    };
    const adapter = new AntigravityRuntimeAuthAdapter(host);
    const result = await adapter.startLogin(
      { workingDirectory: dir, timeoutMs: 500 },
      { onEvent: () => {}, prompt: async () => "" },
    );
    expect(result).toEqual(expect.objectContaining({ status: "failed", reason: "timed_out" }));
    expect(spawned).toHaveLength(1);
    await expect(spawned[0]!.exited).resolves.toBeGreaterThanOrEqual(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a logout the server did not act on is still_logged_in, never a false sign-out", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(
      authHost(dir, { AGY_ACP_FIXTURE_LOGOUT_NOOP: "1" }),
    );
    const result = await adapter.logout({ workingDirectory: dir });
    expect(result).toEqual({ status: "failed", reason: "still_logged_in" });
    const status = await adapter.readStatus({ workingDirectory: dir });
    expect(status.state).toBe("logged_in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resumed session on a signed-out server asks for the Computer page's sign-in", async () => {
  const dir = await cwd();
  try {
    const { AntigravityAcpProvider } = await import("@lrm/coforge-anvil/antigravity");
    const provider = new AntigravityAcpProvider({
      host: {
        command: [process.execPath, FIXTURE],
        buildEnvironment: () => ({ AGY_ACP_FIXTURE_SIGNED_OUT: "1" }),
        processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
        clientInfo: { name: "agy-acp-fixture", version: "1" },
        maskAccountLabel: () => undefined,
        versionReader: async () => "1.5.0",
        catalogCommandRunner: async () => ({ output: "{}", exitCode: 0 }),
        readUsageEnvironment: () => ({}),
        createReplyIntentScanner: () => ({
          feed: () => undefined,
          complete: () => {},
          reset: () => [],
        }),
        isShellToolName: () => false,
      } as never,
      command: [process.execPath, FIXTURE],
    });
    const error = await provider
      .createAgentSession({ workingDirectory: dir, sessionId: "stored-session" } as never)
      .catch((failure: unknown) => failure);
    // The launch names the Computer page in its Activity sentence, not a terminal command.
    expect(error).toMatchObject({
      code: "runtime_login_required",
      detailHint: expect.stringContaining("Computer page"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session/new -32000 maps to a RuntimeLoginRequiredError on the launch path", async () => {
  const dir = await cwd();
  try {
    const { AntigravityAcpProvider } = await import("@lrm/coforge-anvil/antigravity");
    const provider = new AntigravityAcpProvider({
      host: {
        command: [process.execPath, FIXTURE],
        buildEnvironment: () => ({ AGY_ACP_FIXTURE_SIGNED_OUT: "1" }),
        processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
        clientInfo: { name: "agy-acp-fixture", version: "1" },
        maskAccountLabel: () => undefined,
      } as never,
      command: [process.execPath, FIXTURE],
    });
    await expect(
      provider.createAgentSession({ workingDirectory: dir } as never),
    ).rejects.toMatchObject({ code: "runtime_login_required" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

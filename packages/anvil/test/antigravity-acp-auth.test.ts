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

test("a login on a desktop-less Computer is refused before any process spawns", async () => {
  const dir = await cwd();
  try {
    const adapter = new AntigravityRuntimeAuthAdapter(authHost(dir, {}, false));
    const result = await adapter.startLogin(
      { workingDirectory: dir },
      { onEvent: () => {}, prompt: async () => "" },
    );
    expect(result.status).toBe("failed");
    expect((result as { detail?: string }).detail).toMatch(/desktop/i);
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

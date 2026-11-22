import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { createOpenCodeAcpSession } from "#src/opencode/acp-session";
import type { OwnedChildProcess } from "#src/process-tree";
import {
  discoverOpenCodeAcpCatalog,
  OpenCodeAcpProvider,
  readOpenCodeModelEfforts,
  type OpenCodeAcpRuntimeHost,
} from "@lrm/coforge-anvil/opencode";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const command = [process.execPath, new URL("./fixtures/opencode-acp.ts", import.meta.url).pathname];

function startupHost(
  observe: (environment: Readonly<Record<string, string>>) => void,
): OpenCodeAcpRuntimeHost {
  return {
    clientInfo: { name: "oc-startup-fixture", version: "1" },
    processTreeSpawner: {
      spawn(args, directory, environment) {
        observe(environment);
        return fixturePerTurnHost.processTreeSpawner.spawn(args, directory, environment);
      },
    },
    buildEnvironment: ({ environment }) => ({ ...environment }),
    versionReader: async () => "2.1.0",
    createReplyIntentScanner: () => ({ feed: () => undefined, complete() {}, reset: () => [] }),
    isShellToolName: () => false,
  };
}

test("OpenCode serializes same-db resume, launch, catalog and effort initialization", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-startup-"));
  await mkdir(join(cwd, "same"), { recursive: true });
  const spawned: string[] = [];
  const held = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  const host = startupHost((environment) => spawned.push(environment.TEST_LAUNCH ?? ""));
  const provider = new OpenCodeAcpProvider({ host, command });
  const options = (name: string, path = "same"): AgentSessionOptions => ({
    agentWorkspaceDirectory: cwd,
    instructions: "Fixture instructions.",
    environment: { XDG_DATA_HOME: join(cwd, path), TEST_LAUNCH: name },
  });
  const sessions: Promise<AgentSession>[] = [];
  const probes: Promise<unknown>[] = [];
  try {
    sessions.push(
      provider.createAgentSession({
        ...options("resume"),
        sessionId: "original",
        async onSessionId(id) {
          expect(id).toBe("original");
          opened.resolve();
          await held.promise;
        },
      }),
    );
    await Promise.race([opened.promise, sessions[0]]);
    const cancelled = new AbortController();
    const cancellation = provider.createAgentSession({
      ...options("cancelled"),
      startupSignal: cancelled.signal,
    });
    probes.push(cancellation);
    void cancellation.catch(() => undefined);
    const timedOutProvider = new OpenCodeAcpProvider({ host, command, acpTimeoutMs: 50 });
    const timeout = timedOutProvider.createAgentSession(options("expired"));
    probes.push(timeout);
    void timeout.catch(() => undefined);
    sessions.push(provider.createAgentSession(options("fresh")));
    const catalogOptions = {
      ...options("catalog", "unused").environment,
      OPENCODE_DB: join(cwd, "same", "opencode", "opencode.db"),
    };
    const catalog = discoverOpenCodeAcpCatalog(command, cwd, catalogOptions, host);
    const efforts = readOpenCodeModelEfforts(command, cwd, options("efforts").environment!, host, [
      "opencode/model-b",
    ]);
    probes.push(catalog, efforts);
    sessions.push(provider.createAgentSession(options("separate", "other")));
    await sessions.at(-1);
    cancelled.abort();
    await expect(cancellation).rejects.toHaveProperty("name", "AbortError");
    await expect(timeout).rejects.toThrow("timed out waiting for database startup");
    expect(spawned).toEqual(["resume", "separate"]);
    held.resolve();
    expect((await catalog)?.models.map(({ id }) => id)).toContain("opencode/model-b");
    expect((await efforts).get("opencode/model-b")).toEqual({
      status: "ready",
      efforts: ["low", "high"],
    });
    await Promise.all(sessions);
    expect(spawned.toSorted()).toEqual(["catalog", "efforts", "fresh", "resume", "separate"]);
  } finally {
    held.resolve();
    for (const result of await Promise.allSettled(sessions))
      if (result.status === "fulfilled") await result.value.dispose();
    await Promise.allSettled(probes);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a timed-out OpenCode startup releases the same db only after the owned child exits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-startup-failed-"));
  const environment = { XDG_DATA_HOME: cwd };
  const cleanupStarted = Promise.withResolvers<void>();
  const allowCleanup = Promise.withResolvers<void>();
  const spawnOrder: string[] = [];
  const host = startupHost((env) => spawnOrder.push(env.TEST_LAUNCH ?? ""));
  const spawn = host.processTreeSpawner.spawn;
  host.processTreeSpawner.spawn = (...args) => {
    const process = spawn(...args);
    if (args[2].TEST_LAUNCH !== "first") return process;
    return {
      ...process,
      async terminate(force) {
        cleanupStarted.resolve();
        await allowCleanup.promise;
        await process.terminate(force);
        await process.child.exited;
        spawnOrder.push("first exited");
      },
    };
  };
  const first = new OpenCodeAcpProvider({ command, host, acpTimeoutMs: 800 });
  const second = new OpenCodeAcpProvider({ command, host });
  const pending: Promise<AgentSession>[] = [];
  let catalog: ReturnType<typeof discoverOpenCodeAcpCatalog> | undefined;
  try {
    const timedOut = first.createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "First.",
      environment: {
        ...environment,
        TEST_LAUNCH: "first",
        OPENCODE_ACP_FIXTURE_HANG_SESSION_OPEN: "1",
      },
    });
    pending.push(timedOut);
    void timedOut.catch(() => undefined);
    await Promise.race([cleanupStarted.promise, timedOut]);
    catalog = discoverOpenCodeAcpCatalog(command, cwd, environment, host);
    const ready = second.createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Second.",
      environment: { ...environment, TEST_LAUNCH: "second" },
    });
    pending.push(ready);
    await Bun.sleep(50);
    expect(spawnOrder).toEqual(["first"]);
    allowCleanup.resolve();
    await expect(timedOut).rejects.toThrow("session/new timed out");
    await ready;
    expect((await catalog)?.models.length).toBeGreaterThan(0);
    expect(spawnOrder.slice(0, 2)).toEqual(["first", "first exited"]);
    expect(spawnOrder).toContain("second");
  } finally {
    allowCleanup.resolve();
    for (const result of await Promise.allSettled(pending))
      if (result.status === "fulfilled") await result.value.dispose();
    await catalog;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a cold database and a dangling symlink to it share startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-startup-alias-"));
  const windows = process.platform === "win32";
  const target = windows ? join(cwd, "cold", "db.sqlite") : join(cwd, "cold.db");
  const alias = windows ? join(cwd, "alias", "db.sqlite") : join(cwd, "alias.db");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const spawned: string[] = [];
  const host = startupHost((env) => spawned.push(env.TEST_LAUNCH ?? ""));
  const provider = new OpenCodeAcpProvider({ command, host });
  const runs: Promise<AgentSession>[] = [];
  try {
    if (windows) await symlink(join(cwd, "cold"), join(cwd, "alias"), "junction");
    else await symlink("cold.db", alias);
    const options = (db: string, name: string): AgentSessionOptions => ({
      agentWorkspaceDirectory: cwd,
      instructions: name,
      environment: { XDG_DATA_HOME: cwd, OPENCODE_DB: db, TEST_LAUNCH: name },
    });
    runs.push(
      provider.createAgentSession({
        ...options(alias, "alias"),
        async onSessionId() {
          entered.resolve();
          await release.promise;
        },
      }),
    );
    await Promise.race([entered.promise, runs[0]]);
    runs.push(provider.createAgentSession(options(target, "target")));
    runs.push(provider.createAgentSession(options(join(cwd, "unrelated.db"), "other")));
    await runs.at(-1);
    expect(spawned).toEqual(["alias", "other"]);
    release.resolve();
    await Promise.all(runs);
    expect(spawned).toEqual(["alias", "other", "target"]);
  } finally {
    release.resolve();
    for (const result of await Promise.allSettled(runs))
      if (result.status === "fulfilled") await result.value.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dual cleanup failures retain the queue until a late exit can be confirmed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-startup-late-exit-"));
  const spawned: string[] = [];
  let firstChild: OwnedChildProcess | undefined;
  let removed = 0;
  const host = startupHost((env) => spawned.push(env.TEST_LAUNCH ?? ""));
  const spawn = host.processTreeSpawner.spawn;
  host.processTreeSpawner.spawn = (...args) => {
    const tree = spawn(...args);
    if (args[2].TEST_LAUNCH !== "first") return tree;
    const child = (firstChild = tree.child);
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });
    return {
      ...tree,
      async terminate() {},
      async waitForExit() {
        return exited;
      },
    };
  };
  const options = (name: string): AgentSessionOptions => ({
    agentWorkspaceDirectory: cwd,
    instructions: name,
    environment: { XDG_DATA_HOME: cwd, TEST_LAUNCH: name },
  });
  const provider = new OpenCodeAcpProvider({ command, host, acpTimeoutMs: 200 });
  const pending: Promise<AgentSession>[] = [];
  try {
    await expect(
      createOpenCodeAcpSession(
        {
          ...options("first"),
          environment: {
            ...options("first").environment,
            OPENCODE_ACP_FIXTURE_HANG_SESSION_OPEN: "1",
          },
        },
        command,
        host,
        {
          directory: cwd,
          path: join(cwd, "instructions.md"),
          configContent: "{}",
          async remove() {
            removed += 1;
            throw new Error("Cannot delete test instructions");
          },
        },
        400,
      ),
    ).rejects.toHaveProperty("name", "AgentProcessCleanupError");
    expect(removed).toBe(1);
    const blocked = provider.createAgentSession(options("before-exit"));
    pending.push(blocked);
    await expect(blocked).rejects.toThrow("timed out waiting for database startup");
    expect(spawned).toEqual(["first"]);
    expect(firstChild?.exitCode).toBe(null);
    const recovered = new OpenCodeAcpProvider({ command, host }).createAgentSession(
      options("after-exit"),
    );
    pending.push(recovered);
    firstChild?.kill("SIGKILL");
    await firstChild?.exited;
    await recovered;
    expect(spawned).toEqual(["first", "after-exit"]);
  } finally {
    firstChild?.kill("SIGKILL");
    await firstChild?.exited;
    for (const result of await Promise.allSettled(pending))
      if (result.status === "fulfilled") await result.value.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 8000);

test("cold database names follow the filesystem's case semantics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-startup-case-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const spawned: string[] = [];
  const host = startupHost((env) => spawned.push(env.TEST_LAUNCH ?? ""));
  const provider = new OpenCodeAcpProvider({ command, host });
  const runs: Promise<AgentSession>[] = [];
  try {
    await mkdir(join(cwd, "case-sample"));
    const caseInsensitive = await stat(join(cwd, "CASE-SAMPLE")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    const open = (name: string, onSessionId?: AgentSessionOptions["onSessionId"]) => {
      const session = provider.createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: name,
        onSessionId,
        environment: { OPENCODE_DB: join(cwd, name), TEST_LAUNCH: name },
      });
      runs.push(session);
      return session;
    };
    const first = open("DATA.db", async () => {
      entered.resolve();
      await release.promise;
    });
    await Promise.race([entered.promise, first]);
    const alias = open("data.db");
    await open("separate.db");
    if (!caseInsensitive) await alias;
    expect(spawned.includes("data.db")).toBe(!caseInsensitive);
    release.resolve();
    await Promise.all(runs);
    expect(spawned).toContain("data.db");
  } finally {
    release.resolve();
    for (const result of await Promise.allSettled(runs))
      if (result.status === "fulfilled") await result.value.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

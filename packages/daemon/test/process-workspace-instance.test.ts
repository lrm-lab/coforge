import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  ProcessWorkspaceInstance,
  spawnWithGroupFallback,
  writeWorkspaceInstanceRecord,
} from "#src/supervisor/process-workspace-instance";
import type { WorkspaceInstanceConfig } from "#src/supervisor/workspace-instance";
import {
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
} from "#src/supervisor/workspace-health-journal";

async function config(): Promise<WorkspaceInstanceConfig & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), "coforge-windows-workspace-"));
  return {
    root,
    stateRoot: root,
    workspaceId: "workspace-a",
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: join(root, "workspaces", "a", "daemon.sock"),
    stateDirectory: join(root, "workspaces", "a"),
    unitDirectory: join(root, "windows-workspaces"),
    supervisorSocketPath: join(root, "daemon.sock"),
    daemonConnectionEndpoint: "ws://127.0.0.1:8000/connection/websocket",
  };
}

test("ensureStarted spawns __workspace-daemon once and reuses a live PID", async () => {
  const cfg = await config();
  const spawns: { command: string[]; env: Record<string, string> }[] = [];
  let authorizations = 0;
  const authorize = async () => {
    authorizations++;
  };
  let alive = true;
  const savedDaemonApiKey = process.env.COFORGE_DAEMON_API_KEY;
  try {
    process.env.COFORGE_DAEMON_API_KEY = "dk_computer-secret";
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async (input) => {
        expect(authorizations).toBe(1);
        spawns.push({ command: input.command, env: input.env });
        return { pid: 4242 };
      },
      () => alive,
    );
    expect(await instance.ensureStarted(authorize)).toBe(4242);
    expect(await instance.ensureStarted(authorize)).toBe(4242);
    expect(authorizations).toBe(1);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toEqual([
      "C:\\Coforge\\coforge-computer.exe",
      "__workspace-daemon",
      "--socket",
      cfg.socketPath,
      "--state-directory",
      cfg.stateDirectory,
    ]);
    expect(spawns[0]?.env.COFORGE_DAEMON_HOME).toBe(cfg.stateDirectory);
    expect(spawns[0]?.env.COFORGE_SUPERVISOR_SOCKET).toBe(cfg.supervisorSocketPath);
    expect(spawns[0]?.env.COFORGE_DAEMON_CONNECTION_ENDPOINT).toBe(
      "ws://127.0.0.1:8000/connection/websocket",
    );
    expect(spawns[0]?.env.COFORGE_DAEMON_API_KEY).toBeUndefined();
    // The child self-registers the instance record so a Coordinator that dies before its own
    // write still leaves an adoptable live instance.
    expect(spawns[0]?.env.COFORGE_WORKSPACE_INSTANCE_RECORD).toBe(
      join(cfg.stateDirectory, "process-instance.json"),
    );
    expect(spawns[0]?.env.COFORGE_WORKSPACE_INVOCATION_ID).toMatch(/^[0-9a-f]{32}$/);
    const first = await instance.identity();
    expect(first).toMatchObject({ mainPid: 4242, active: true });
    expect(first?.invocationId).toMatch(/^[0-9a-f]{32}$/);

    alive = false;
    expect(await instance.ensureStarted()).toBe(4242);
    expect(spawns).toHaveLength(2);
    const second = await instance.identity();
    expect(second?.invocationId).not.toBe(first?.invocationId);
  } finally {
    if (savedDaemonApiKey === undefined) delete process.env.COFORGE_DAEMON_API_KEY;
    else process.env.COFORGE_DAEMON_API_KEY = savedDaemonApiKey;
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("stop clears the durable instance record after signalling the child", async () => {
  const cfg = await config();
  const signals: Array<{ pid: number; signal?: NodeJS.Signals }> = [];
  let alive = true;
  try {
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async () => ({ pid: 77 }),
      () => alive,
      (pid, signal) => {
        signals.push({ pid, signal });
        alive = false;
      },
    );
    await instance.ensureStarted();
    await instance.stop();
    expect(signals).toEqual([{ pid: 77, signal: undefined }]);
    expect(await instance.identity()).toBeNull();
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("stop clears the health live marker after an intentional Windows SIGTERM/SIGKILL", async () => {
  // Upgrade/reload stops go through ProcessWorkspaceInstance.stop. If SIGKILL wins the race
  // before the child's SIGTERM shutdown runs recordGracefulStop, the next start would count a
  // crash and trip the degraded latch. Clearing live here is Windows-only and intentional.
  const cfg = await config();
  let alive = true;
  try {
    await mkdir(cfg.stateDirectory, { recursive: true });
    const journalPath = workspaceHealthJournalPath(cfg.stateDirectory);
    await writeFile(
      journalPath,
      `${JSON.stringify({ schemaVersion: 1, live: true, crashes: [] })}\n`,
      { mode: 0o600 },
    );
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async () => ({ pid: 88 }),
      () => alive,
      () => {
        alive = false;
      },
    );
    await instance.ensureStarted();
    await instance.stop();
    const journal = new WorkspaceHealthJournal(journalPath);
    expect(await journal.wasLeftRunning()).toBe(false);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("stop does not clear the live marker when the Windows child was already dead", async () => {
  // Reconcile must not erase an unexpected death before the replacement child can recordCrash.
  const cfg = await config();
  try {
    await mkdir(cfg.stateDirectory, { recursive: true });
    const journalPath = workspaceHealthJournalPath(cfg.stateDirectory);
    await writeFile(
      journalPath,
      `${JSON.stringify({ schemaVersion: 1, live: true, crashes: [] })}\n`,
      { mode: 0o600 },
    );
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async () => ({ pid: 99 }),
      () => false,
      () => {
        throw new Error("should not signal a dead process");
      },
    );
    await instance.ensureStarted();
    await instance.stop();
    expect(await new WorkspaceHealthJournal(journalPath).wasLeftRunning()).toBe(true);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("identity key is stable for the state root and Workspace", async () => {
  const cfg = await config();
  try {
    const a = new ProcessWorkspaceInstance(
      cfg,
      async () => ({ pid: 1 }),
      () => false,
    );
    const same = new ProcessWorkspaceInstance(
      cfg,
      async () => ({ pid: 1 }),
      () => false,
    );
    const b = new ProcessWorkspaceInstance(
      { ...cfg, workspaceId: "workspace-b" },
      async () => ({ pid: 1 }),
      () => false,
    );
    expect(a.identityKey).toBe(same.identityKey);
    expect(a.identityKey).not.toBe(b.identityKey);
    expect(a.identityKey).toMatch(/^[0-9a-f]{24}$/);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("adopts a record left under the Windows-only name, and replaces it on the next write", async () => {
  const cfg = await config();
  try {
    await mkdir(cfg.stateDirectory, { recursive: true });
    const legacy = join(cfg.stateDirectory, "windows-instance.json");
    await Bun.write(legacy, persistedRecordUnderLegacyName());
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async () => {
        throw new Error("must adopt the live child");
      },
      () => false,
    );
    expect(await instance.identity()).toMatchObject({ mainPid: 73, active: false });
    await instance.stop();
    // The old name is not left behind to be read again by the next Coordinator.
    expect(await Bun.file(legacy).exists()).toBe(false);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

const persistedInvocation = "ABCDEF0123456789ABCDEF0123456789";
const persistedRecordUnderLegacyName = () =>
  `{"mainPid":73,"invocationId":"ABCDEF0123456789ABCDEF0123456789"}\n`;
const persistedRecord = `{"mainPid":73,"invocationId":"${persistedInvocation}","extra":"中文"}`;

for (const [name, bytes] of [
  ["UTF-8", Buffer.from(persistedRecord)],
  [
    "replacement-decoded UTF-8 in an unused field",
    Buffer.concat([
      Buffer.from(`{"mainPid":73,"invocationId":"${persistedInvocation}","extra":"`),
      Buffer.from([255]),
      Buffer.from('"}'),
    ]),
  ],
] as const) {
  test(`adopts an existing process instance record with ${name} without rewriting it`, async () => {
    const cfg = await config();
    try {
      await mkdir(cfg.stateDirectory, { recursive: true });
      const path = join(cfg.stateDirectory, "process-instance.json");
      await Bun.write(path, bytes);
      const instance = new ProcessWorkspaceInstance(
        cfg,
        async () => {
          throw new Error("must adopt the live child");
        },
        (pid) => pid === 73,
      );
      expect(await instance.identity()).toEqual({
        mainPid: 73,
        active: true,
        invocationId: "abcdef0123456789abcdef0123456789",
      });
      expect(await instance.ensureStarted()).toBe(73);
      expect(await Bun.file(path).bytes()).toEqual(new Uint8Array(bytes));
    } finally {
      await rm(cfg.root, { recursive: true, force: true });
    }
  });
}

for (const [name, bytes] of [
  ["UTF-8 BOM", Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(persistedRecord)])],
  [
    "UTF-16LE BOM",
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(persistedRecord, "utf16le")]),
  ],
  ["truncated JSON", Buffer.from('{"mainPid":')],
] as const) {
  test(`propagates a process instance record's ${name} parse failure before process operations`, async () => {
    const cfg = await config();
    try {
      await mkdir(cfg.stateDirectory, { recursive: true });
      const path = join(cfg.stateDirectory, "process-instance.json");
      await Bun.write(path, bytes);
      const unexpected = () => {
        throw new Error("must not operate on a damaged record");
      };
      const instance = new ProcessWorkspaceInstance(
        cfg,
        async () => unexpected(),
        unexpected,
        unexpected,
      );
      await expect(instance.identity()).rejects.toBeInstanceOf(SyntaxError);
      await expect(instance.ensureStarted()).rejects.toBeInstanceOf(SyntaxError);
      await expect(instance.stop()).rejects.toBeInstanceOf(SyntaxError);
      expect(await Bun.file(path).bytes()).toEqual(new Uint8Array(bytes));
    } finally {
      await rm(cfg.root, { recursive: true, force: true });
    }
  });
}

for (const code of ["EISDIR", "ENOTDIR"] as const) {
  test(`propagates a process instance record's ${code} read failure before process operations`, async () => {
    const cfg = await config();
    try {
      if (code === "EISDIR")
        await mkdir(join(cfg.stateDirectory, "process-instance.json"), { recursive: true });
      else {
        await mkdir(dirname(cfg.stateDirectory), { recursive: true });
        await Bun.write(cfg.stateDirectory, "not a directory");
      }
      const unexpected = () => {
        throw new Error("must not operate on an unreadable record");
      };
      const instance = new ProcessWorkspaceInstance(
        cfg,
        async () => unexpected(),
        unexpected,
        unexpected,
      );
      await expect(instance.identity()).rejects.toMatchObject({ code });
      await expect(instance.ensureStarted()).rejects.toMatchObject({ code });
      await expect(instance.stop()).rejects.toMatchObject({ code });
    } finally {
      await rm(cfg.root, { recursive: true, force: true });
    }
  });
}

for (const record of [
  undefined,
  { mainPid: 0, invocationId: persistedInvocation },
  { mainPid: 73, invocationId: "bad" },
]) {
  test(`starts a fresh Windows instance after ${record === undefined ? "a missing" : JSON.stringify(record)} record`, async () => {
    const cfg = await config();
    let started = false;
    try {
      if (record) {
        await mkdir(cfg.stateDirectory, { recursive: true });
        await Bun.write(join(cfg.stateDirectory, "process-instance.json"), JSON.stringify(record));
      }
      const instance = new ProcessWorkspaceInstance(
        cfg,
        async () => {
          started = true;
          return { pid: 74 };
        },
        (pid) => started && pid === 74,
      );
      expect(await instance.identity()).toBeNull();
      expect(await instance.ensureStarted()).toBe(74);
      expect(await instance.identity()).toMatchObject({ mainPid: 74, active: true });
    } finally {
      await rm(cfg.root, { recursive: true, force: true });
    }
  });
}

test("writeWorkspaceInstanceRecord writes the record and retires the legacy name", async () => {
  const cfg = await config();
  try {
    await mkdir(cfg.stateDirectory, { recursive: true });
    const legacyPath = join(cfg.stateDirectory, "windows-instance.json");
    await Bun.write(legacyPath, "{}");
    const recordPath = join(cfg.stateDirectory, "process-instance.json");
    const invocationId = "0123456789abcdef0123456789abcdef";
    await writeWorkspaceInstanceRecord(recordPath, { mainPid: 5150, invocationId });
    await expect(Bun.file(recordPath).json()).resolves.toEqual({
      mainPid: 5150,
      invocationId,
    });
    await expect(Bun.file(legacyPath).exists()).resolves.toBe(false);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

const FAST_STOP = { termGraceMs: 20, killConfirmMs: 100, pollMs: 2 };

test("stop waits for the process to be gone after SIGKILL before dropping the record", async () => {
  const cfg = await config();
  try {
    let killed = false;
    let probesAfterKill = 0;
    const signals: (string | undefined)[] = [];
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async () => ({ pid: 77 }),
      () => {
        if (!killed) return true;
        probesAfterKill += 1;
        return probesAfterKill < 4;
      },
      (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") killed = true;
      },
      FAST_STOP,
    );
    await instance.ensureStarted();
    await instance.stop();
    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect(probesAfterKill).toBeGreaterThanOrEqual(4);
    expect(await instance.identity()).toBeNull();
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("stop fails and keeps the record when the process survives SIGKILL", async () => {
  const cfg = await config();
  try {
    await mkdir(cfg.stateDirectory, { recursive: true });
    const journalPath = workspaceHealthJournalPath(cfg.stateDirectory);
    await writeFile(
      journalPath,
      `${JSON.stringify({ schemaVersion: 1, live: true, crashes: [] })}\n`,
      { mode: 0o600 },
    );
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async () => ({ pid: 78 }),
      () => true,
      () => {},
      FAST_STOP,
    );
    await instance.ensureStarted();
    await expect(instance.stop()).rejects.toThrow("did not exit after SIGKILL");
    expect(await instance.identity()).toMatchObject({ mainPid: 78, active: true });
    expect(await new WorkspaceHealthJournal(journalPath).wasLeftRunning()).toBe(true);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("stop returns once a real SIGTERM-ignoring child is killed, and drops the record", async () => {
  const cfg = await config();
  try {
    const instance = new ProcessWorkspaceInstance(
      cfg,
      async () => {
        const child = Bun.spawn({
          cmd: ["sh", "-c", "trap '' TERM; while :; do sleep 0.2; done"],
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        child.unref();
        return { pid: child.pid };
      },
      undefined,
      undefined,
      { termGraceMs: 300, killConfirmMs: 5_000, pollMs: 20 },
    );
    await instance.ensureStarted();
    await Bun.sleep(300);
    const started = Date.now();
    await instance.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await instance.identity()).toBeNull();
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("a record file that exists but is still empty reads as no record", async () => {
  const base = await config();
  const instance = new ProcessWorkspaceInstance(base, async () => ({ pid: 1 }));
  await mkdir(base.stateDirectory, { recursive: true });
  await writeFile(join(base.stateDirectory, "process-instance.json"), "");
  expect(await instance.identity()).toBeNull();
});

test("a rejected shared group is retried once on the Workspace's own gid", async () => {
  const attempts: (number | undefined)[] = [];
  const warnings: { message: string; details: Record<string, unknown> }[] = [];
  const result = await spawnWithGroupFallback({
    workspaceId: "workspace-a",
    uid: 20_101,
    sharedGid: 20_100,
    spawn: async (gid) => {
      attempts.push(gid);
      if (attempts.length === 1)
        throw Object.assign(new Error("setgid failed"), { code: "EINVAL" });
      return { pid: 42 };
    },
    warn: (message, details) => warnings.push({ message, details }),
  });
  expect(result).toEqual({ pid: 42 });
  expect(attempts).toEqual([20_100, undefined]);
  expect(warnings[0]?.details).toEqual({
    workspaceId: "workspace-a",
    sharedGid: 20_100,
    uid: 20_101,
    code: "EINVAL",
  });
});

test("any other spawn failure is not retried, so the cause stays single", async () => {
  const attempts: (number | undefined)[] = [];
  await expect(
    spawnWithGroupFallback({
      workspaceId: "workspace-a",
      uid: 20_101,
      sharedGid: 20_100,
      spawn: async (gid) => {
        attempts.push(gid);
        throw Object.assign(new Error("spawn failed"), { code: "EACCES" });
      },
      warn: () => undefined,
    }),
  ).rejects.toThrow(/spawn failed/);
  expect(attempts).toEqual([20_100]);
});

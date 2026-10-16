import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { WindowsWorkspaceInstance } from "#src/supervisor/windows-workspace-instance";
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
  let alive = true;
  try {
    const instance = new WindowsWorkspaceInstance(
      cfg,
      async (input) => {
        spawns.push({ command: input.command, env: input.env });
        return { pid: 4242 };
      },
      () => alive,
    );
    expect(await instance.ensureStarted()).toBe(4242);
    expect(await instance.ensureStarted()).toBe(4242);
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
    const first = await instance.identity();
    expect(first).toMatchObject({ mainPid: 4242, active: true });
    expect(first?.invocationId).toMatch(/^[0-9a-f]{32}$/);

    alive = false;
    expect(await instance.ensureStarted()).toBe(4242);
    expect(spawns).toHaveLength(2);
    const second = await instance.identity();
    expect(second?.invocationId).not.toBe(first?.invocationId);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("stop clears the durable instance record after signalling the child", async () => {
  const cfg = await config();
  const signals: Array<{ pid: number; signal?: NodeJS.Signals }> = [];
  let alive = true;
  try {
    const instance = new WindowsWorkspaceInstance(
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
  // Upgrade/reload stops go through WindowsWorkspaceInstance.stop. If SIGKILL wins the race
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
    const instance = new WindowsWorkspaceInstance(
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
    const instance = new WindowsWorkspaceInstance(
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
    const a = new WindowsWorkspaceInstance(
      cfg,
      async () => ({ pid: 1 }),
      () => false,
    );
    const same = new WindowsWorkspaceInstance(
      cfg,
      async () => ({ pid: 1 }),
      () => false,
    );
    const b = new WindowsWorkspaceInstance(
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

const persistedInvocation = "ABCDEF0123456789ABCDEF0123456789";
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
  test(`adopts an existing Windows instance record with ${name} without rewriting it`, async () => {
    const cfg = await config();
    try {
      await mkdir(cfg.stateDirectory, { recursive: true });
      const path = join(cfg.stateDirectory, "windows-instance.json");
      await Bun.write(path, bytes);
      const instance = new WindowsWorkspaceInstance(
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
  test(`propagates a Windows instance record's ${name} parse failure before process operations`, async () => {
    const cfg = await config();
    try {
      await mkdir(cfg.stateDirectory, { recursive: true });
      const path = join(cfg.stateDirectory, "windows-instance.json");
      await Bun.write(path, bytes);
      const unexpected = () => {
        throw new Error("must not operate on a damaged record");
      };
      const instance = new WindowsWorkspaceInstance(
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
  test(`propagates a Windows instance record's ${code} read failure before process operations`, async () => {
    const cfg = await config();
    try {
      if (code === "EISDIR")
        await mkdir(join(cfg.stateDirectory, "windows-instance.json"), { recursive: true });
      else {
        await mkdir(dirname(cfg.stateDirectory), { recursive: true });
        await Bun.write(cfg.stateDirectory, "not a directory");
      }
      const unexpected = () => {
        throw new Error("must not operate on an unreadable record");
      };
      const instance = new WindowsWorkspaceInstance(
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
        await Bun.write(join(cfg.stateDirectory, "windows-instance.json"), JSON.stringify(record));
      }
      const instance = new WindowsWorkspaceInstance(
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

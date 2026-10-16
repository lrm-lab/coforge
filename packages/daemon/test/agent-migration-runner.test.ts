import { afterEach, expect, spyOn, test } from "bun:test";
import * as fileSystem from "node:fs/promises";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_MIGRATION_COMMIT_MARKER } from "#src/agent-migration/bundle-commit";
import { AGENT_MIGRATION_IGNORE_FILE } from "#src/agent-migration/selection-rules";
import { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import { AgentMigrationRemoteError } from "#src/agent-migration/transfer-ports";
import { cloud } from "./fixtures/agent-migration-cloud";
import { captureDaemonLogs } from "./log-capture";

const roots: string[] = [];
const runners: AgentMigrationRunner[] = [];
const WORKSPACE_RACE_TIMEOUT_MS = 4_000;
afterEach(async () => {
  const closed = await Promise.allSettled(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const result of closed) if (result.status === "rejected") throw result.reason;
});

async function temp(prefix: string) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}

const migrationId = "migration-1";
const agentId = "agent-1";

test.each([
  {
    name: "a returned workspace stays placed while an earlier source archive finishes",
    mode: "placement",
    expected: {
      returningState: "switched",
      memory: "returned workspace",
      lastReport: "target:switch",
    },
  },
  {
    name: "a lease that expires waiting for an earlier archive places no workspace",
    mode: "expired",
    expected: { returningState: "failed", memory: null, lastReport: "target:fail:lease_expired" },
  },
])(
  "$name",
  async ({ mode, expected }) => {
    const root = await temp("agent-migration-workspace-race-");
    const fixture = Bun.fileURLToPath(
      new URL("./fixtures/agent-migration-workspace-race.ts", import.meta.url),
    );
    const child = Bun.spawn([process.execPath, fixture, root, mode], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: WORKSPACE_RACE_TIMEOUT_MS,
    });
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        outgoingState: "completed",
        archived: "original workspace",
        ...expected,
      });
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  },
  WORKSPACE_RACE_TIMEOUT_MS + 1_000,
);

async function computer(name: string, shared: ReturnType<typeof cloud>, role: "source" | "target") {
  const root = await temp(`agent-migration-${name}-`);
  const stops: string[] = [];
  const movedAway: string[] = [];
  const running = new Set<string>(role === "source" ? [agentId] : []);
  const runner = new AgentMigrationRunner({
    server: () => shared.serverFor(role),
    bucket: shared.bucket,
    agents: {
      stop: async (id) => {
        stops.push(id);
        running.delete(id);
      },
      isRunning: (id) => running.has(id),
      movedAway: (id) => movedAway.push(id),
    },
    workspaceDirectory: (id) => join(root, "agents", id),
    stateDirectory: join(root, "state"),
    outcomePollMs: 5,
  });
  runners.push(runner);
  return {
    root,
    runner,
    stops,
    movedAway,
    workspace: join(root, "agents", agentId),
    state: join(root, "state"),
  };
}

const lease = (role: "source" | "target", revision: number) => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: "workspace-1",
  computerId: role === "source" ? "computer-a" : "computer-b",
  agentId,
  migrationId,
  generation: 1,
  role,
  expectedRevision: revision,
  expiresInMs: 60_000,
  deadline: Date.now() + 60_000,
});

async function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await Bun.write(join(root, path), content);
  }
}

/** Waits for a condition the runs under test reach on their own, never for a fixed time. */
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(2);
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The source has uploaded and is now holding the Agent until the migration is decided. */
async function uploaded(shared: ReturnType<typeof cloud>, files: Record<string, string>) {
  const source = await computer("source", shared, "source");
  await write(source.workspace, files);
  const run = source.runner.lease(lease("source", 0));
  await until(() => shared.record.state === "uploaded");
  return { source, run };
}

test("a leased source and then a leased target move the Agent's workspace between Computers", async () => {
  const shared = cloud();
  const { source, run } = await uploaded(shared, {
    "MEMORY.md": "what I remember",
    "notes/plan.md": "step one",
    "code/repo/README.md": "code stays behind",
    "notes/report.csv": "the report moves",
    ".env": "SECRET=1",
  });
  expect(source.stops).toEqual([agentId]);
  // The ignore file was seeded before selection, so `code/` stayed on the source.
  expect(await readFile(join(source.workspace, AGENT_MIGRATION_IGNORE_FILE), "utf8")).toContain(
    "code",
  );
  // Until the Agent has switched, the source keeps it stopped.
  expect(source.runner.holds(agentId)).toBe(true);

  const target = await computer("target", shared, "target");
  await target.runner.lease(lease("target", shared.record.revision));
  await run;
  expect(shared.reports).toEqual([
    "source:source_stopped",
    "source:upload_complete",
    "target:placement_started",
    "target:switch",
  ]);
  expect(shared.record.state).toBe("switched");
  expect(source.runner.holds(agentId)).toBe(false);
  expect(await readFile(join(target.workspace, "MEMORY.md"), "utf8")).toBe("what I remember");
  expect(await readFile(join(target.workspace, "notes/plan.md"), "utf8")).toBe("step one");
  expect(await exists(join(target.workspace, "code"))).toBe(false);
  expect(await readFile(join(target.workspace, "notes/report.csv"), "utf8")).toBe(
    "the report moves",
  );
  expect(await exists(join(target.workspace, ".env"))).toBe(false);
  // The attempt's chunks are gone once the Agent has switched.
  expect(await exists(join(target.state, "migrations", migrationId, "1"))).toBe(false);
  // The source keeps what the Agent left behind as a backup, out of the Agents' tree.
  expect(await exists(source.workspace)).toBe(false);
  const archived = join(
    source.state,
    "migration-workspace-backups",
    agentId,
    `source-${migrationId}`,
  );
  expect(await readFile(join(archived, "MEMORY.md"), "utf8")).toBe("what I remember");
  expect(await readFile(join(archived, "code/repo/README.md"), "utf8")).toBe("code stays behind");
  // Only the Computer the Agent left forgets it.
  expect(source.movedAway).toEqual([agentId]);
  expect(target.movedAway).toEqual([]);
});

test("a source whose migration failed keeps its workspace where it is", async () => {
  const shared = cloud();
  const { source, run } = await uploaded(shared, { "MEMORY.md": "stays" });
  shared.record.state = "failed";
  await run;
  expect(await readFile(join(source.workspace, "MEMORY.md"), "utf8")).toBe("stays");
});

test("leftover attempts older than a week are cleared when the runner starts", async () => {
  const shared = cloud();
  const target = await computer("target", shared, "target");
  const old = join(target.state, "migrations", "old-migration", "1", "chunks");
  const recent = join(target.state, "migrations", "recent-migration", "1", "chunks");
  await mkdir(old, { recursive: true });
  await mkdir(recent, { recursive: true });
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(join(target.state, "migrations", "old-migration"), weekAgo, weekAgo);
  await target.runner.pruneLeftovers();
  expect(await exists(join(target.state, "migrations", "old-migration"))).toBe(false);
  expect(await exists(recent)).toBe(true);
});

test("a lease delivered again joins the run already going", async () => {
  const shared = cloud();
  const { source, run } = await uploaded(shared, { "MEMORY.md": "m" });
  const again = source.runner.lease({ ...lease("source", 0), deadline: Date.now() + 3_600_000 });
  shared.record.state = "failed";
  await Promise.all([run, again]);
  expect(source.stops).toEqual([agentId]);
  expect(shared.reports.filter((report) => report === "source:source_stopped")).toHaveLength(1);
});

test("a source lets the Agent go once the migration fails elsewhere", async () => {
  const shared = cloud();
  const { source, run } = await uploaded(shared, { "MEMORY.md": "m" });
  shared.record.state = "failed";
  await run;
  expect(source.runner.holds(agentId)).toBe(false);
});

test("a transient server failure is asked again; a transfer that fails is reported by code alone", async () => {
  const shared = cloud();
  shared.faults.view = [new AgentMigrationRemoteError("network", true)];
  shared.faults.source_stopped = [new AgentMigrationRemoteError("bucket_unavailable", true)];
  shared.refuseUploads();
  const source = await computer("source", shared, "source");
  await write(source.workspace, { "MEMORY.md": "m" });
  await source.runner.lease(lease("source", 0));
  expect(shared.reports).toEqual([
    "source:source_stopped",
    "source:source_stopped",
    "source:fail:bucket_refused",
  ]);
  // Local paths and messages stay on this Computer.
  expect(shared.details).toEqual([undefined]);
  expect(source.runner.holds(agentId)).toBe(false);
});

test("a failed run logs its code without the remote error's detail", async () => {
  const shared = cloud();
  const detail = "fixture-private-remote-detail";
  shared.faults.view = [new AgentMigrationRemoteError("bucket_refused", false, detail)];
  const source = await computer("source", shared, "source");

  const { records } = await captureDaemonLogs(() => source.runner.lease(lease("source", 0)));

  const failure = records.find((record) => record.rawMessage === "agent_migration:run_failed");
  expect(failure?.properties).toEqual({
    migration_id: migrationId,
    role: "source",
    agent_id: agentId,
    error_code: "bucket_refused",
  });
  expect(JSON.stringify(records)).not.toContain(detail);
  expect(shared.reports).toEqual(["source:fail:bucket_refused"]);
  expect(source.runner.holds(agentId)).toBe(false);
});

test("a failed failure report logs a normalized code and still releases the Agent", async () => {
  const shared = cloud();
  shared.faults.view = [new AgentMigrationRemoteError("bucket_refused", false)];
  const invalidCode = "fixture-invalid-code/private-detail";
  const reported: unknown[] = [];
  const serverFor = shared.serverFor;
  shared.serverFor = (role) => ({
    ...serverFor(role),
    fail: async (input) => {
      reported.push(input);
      throw new AgentMigrationRemoteError(invalidCode, false);
    },
  });
  const source = await computer("source", shared, "source");

  const { records } = await captureDaemonLogs(() => source.runner.lease(lease("source", 0)));

  const failure = records.find(
    (record) => record.rawMessage === "agent_migration:fail_report_failed",
  );
  expect(failure?.properties).toEqual({
    migration_id: migrationId,
    role: "source",
    agent_id: agentId,
    error_code: "unexpected",
  });
  expect(JSON.stringify(records)).not.toContain(invalidCode);
  expect(reported).toEqual([{ migrationId, generation: 1, errorCode: "bucket_refused" }]);
  expect(source.runner.holds(agentId)).toBe(false);
});

test("a source archive failure logs its code and keeps the completed migration and workspace", async () => {
  const shared = cloud();
  const { result: source, records } = await captureDaemonLogs(async () => {
    const { source, run } = await uploaded(shared, { "MEMORY.md": "stays here" });
    const backups = join(source.state, "migration-workspace-backups", agentId);
    await mkdir(dirname(backups), { recursive: true });
    await Bun.write(backups, "a file prevents the backup directory from being created");
    shared.record.state = "completed";
    await run;
    return source;
  });

  const failure = records.find(
    (record) => record.rawMessage === "agent_migration:source_archive_failed",
  );
  expect(failure?.properties).toEqual({ migration_id: migrationId, error_code: "unexpected" });
  expect(JSON.stringify(records)).not.toContain(source.root);
  expect(shared.record.state).toBe("completed");
  expect(shared.reports).toEqual(["source:source_stopped", "source:upload_complete"]);
  expect(source.runner.holds(agentId)).toBe(false);
  expect(await Bun.file(join(source.workspace, "MEMORY.md")).text()).toBe("stays here");
});

test("a backup cleanup failure logs its code without discarding the backup", async () => {
  const shared = cloud();
  const source = await computer("source", shared, "source");
  const expired = join(source.state, "migration-workspace-backups", agentId, "expired");
  await mkdir(expired, { recursive: true });
  await Bun.write(join(expired, "MEMORY.md"), "recoverable backup");
  await utimes(expired, new Date(0), new Date(0));
  const detail = "fixture-private-prune-detail";
  const remove = fileSystem.rm;
  const removal = spyOn(fileSystem, "rm").mockImplementation(async (path, options) => {
    if (String(path) === expired) throw new Error(detail);
    await remove(path, options);
  });
  try {
    const { records } = await captureDaemonLogs(() => source.runner.pruneLeftovers());

    const failure = records.find(
      (record) => record.rawMessage === "agent_migration:backup_prune_failed",
    );
    expect(failure?.properties).toEqual({ agent_id: agentId, error_code: "unexpected" });
    expect(JSON.stringify(records)).not.toContain(detail);
    expect(await Bun.file(join(expired, "MEMORY.md")).text()).toBe("recoverable backup");
    expect(shared.reports).toEqual([]);
  } finally {
    removal.mockRestore();
  }
});

test("a switch the server refuses puts the target's previous workspace back", async () => {
  const shared = cloud();
  const { run } = await uploaded(shared, { "MEMORY.md": "moved" });
  const target = await computer("target", shared, "target");
  await write(target.workspace, { "MEMORY.md": "what was here before" });
  shared.faults.switch = [new AgentMigrationRemoteError("agent_moved", false)];
  await target.runner.lease(lease("target", shared.record.revision));
  expect(shared.reports.at(-1)).toBe("target:fail:agent_moved");
  expect(await readFile(join(target.workspace, "MEMORY.md"), "utf8")).toBe("what was here before");
  expect(await exists(join(target.state, "migrations", migrationId, "1"))).toBe(false);
  await run;
});

test("a switch whose reply was lost is found to have landed, not reported as a failure", async () => {
  const shared = cloud();
  const { run } = await uploaded(shared, { "MEMORY.md": "moved" });
  const target = await computer("target", shared, "target");
  const serverFor = shared.serverFor;
  // The switch lands, then its reply is lost for good.
  shared.serverFor = (role) => {
    const server = serverFor(role);
    if (role === "source") return server;
    return {
      ...server,
      step: async (input) => {
        const result = await server.step(input);
        if (input.step === "switch") throw new AgentMigrationRemoteError("invalid_response", false);
        return result;
      },
    };
  };
  await target.runner.lease(lease("target", shared.record.revision));
  expect(shared.record.state).toBe("switched");
  expect(shared.reports.some((report) => report.startsWith("target:fail"))).toBe(false);
  expect(await readFile(join(target.workspace, "MEMORY.md"), "utf8")).toBe("moved");
  await run;
});

test("a cancel stops the target's run without reporting a failure, and drops its chunks", async () => {
  const shared = cloud();
  const { run } = await uploaded(shared, { "MEMORY.md": "m" });
  const target = await computer("target", shared, "target");
  const get = shared.bucket.get;
  // Chunk zero arrives; the other chunk stays unavailable, so the run is mid-download.
  shared.bucket.get = async (url, sizeBytes, signal) => {
    if (url === "chunk/0") return get(url, sizeBytes, signal);
    throw new AgentMigrationRemoteError("bucket_unavailable", true);
  };
  shared.record.manifest = {
    ...shared.record.manifest!,
    chunks: [
      ...shared.record.manifest!.chunks,
      { ...shared.record.manifest!.chunks[0]!, index: 1 },
    ],
  };
  const targetRun = target.runner.lease(lease("target", shared.record.revision));
  const attempt = join(target.state, "migrations", migrationId, "1");
  await until(() => exists(join(attempt, "chunks", "0.chunk")));
  await target.runner.cancel({
    protocolMajor: 1,
    requestId: "cancel-1",
    workspaceId: "workspace-1",
    computerId: "computer-b",
    agentId,
    migrationId,
    generation: 1,
    role: "target",
    switched: false,
  });
  await targetRun;
  expect(shared.reports.some((report) => report.startsWith("target:fail"))).toBe(false);
  expect(await exists(attempt)).toBe(false);
  shared.record.state = "canceled";
  await run;
});

test("the source lets the Agent go before the server can answer with a Start", async () => {
  const shared = cloud();
  shared.refuseUploads();
  const source = await computer("source", shared, "source");
  await write(source.workspace, { "MEMORY.md": "m" });
  const serverFor = shared.serverFor;
  let heldWhenReported: boolean | undefined;
  shared.serverFor = (role) => {
    const server = serverFor(role);
    return {
      ...server,
      fail: async (input) => {
        heldWhenReported = source.runner.holds(agentId);
        return server.fail(input);
      },
    };
  };
  await source.runner.lease(lease("source", 0));
  expect(heldWhenReported).toBe(false);

  // A cancel releases the Agent at once, while the run it ends is still winding down.
  const again = cloud();
  const other = await computer("other", again, "source");
  await write(other.workspace, { "MEMORY.md": "m" });
  const run = other.runner.lease(lease("source", 0));
  await until(() => again.record.state === "uploaded");
  const canceled = other.runner.cancel({
    protocolMajor: 1,
    requestId: "cancel-1",
    workspaceId: "workspace-1",
    computerId: "computer-a",
    agentId,
    migrationId,
    generation: 1,
    role: "source",
    switched: false,
  });
  expect(other.runner.holds(agentId)).toBe(false);
  await canceled;
  await run;
});

test("a switched target remains intact when its outcome cannot be confirmed", async () => {
  const shared = cloud();
  const { source, run } = await uploaded(shared, { "MEMORY.md": "moved" });
  const target = await computer("unknown-target", shared, "target");
  try {
    await write(target.workspace, { "MEMORY.md": "old target" });
    const baseServerFor = shared.serverFor;
    let switched = false;
    shared.serverFor = (role) => {
      const server = baseServerFor(role);
      if (role === "source") return server;
      return {
        ...server,
        view: async () => {
          if (switched) throw new AgentMigrationRemoteError("invalid_response", false);
          return server.view(migrationId);
        },
        step: async (input) => {
          const result = await server.step(input);
          if (input.step === "switch") {
            switched = true;
            throw new AgentMigrationRemoteError("invalid_response", false);
          }
          return result;
        },
        fail: async (input) => {
          if (shared.record.state === "switched")
            throw new AgentMigrationRemoteError("past_switch", false);
          return server.fail(input);
        },
      };
    };
    await target.runner.lease(lease("target", shared.record.revision));
    expect(shared.record.state).toBe("switched");
    expect(await Bun.file(join(target.workspace, "MEMORY.md")).text()).toBe("moved");
  } finally {
    await Promise.all([source.runner.close(), target.runner.close()]);
    await run;
  }
});

test("a source run replacing a canceled run retains its hold", async () => {
  const shared = cloud();
  const root = await temp("review-replacement-");
  const workspace = join(root, "workspace");
  await write(workspace, { "MEMORY.md": "moved" });
  let startedFirst = () => {};
  let startedSecond = () => {};
  let releaseFirst = () => {};
  let releaseSecond = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    startedSecond = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let stops = 0;
  const runner = new AgentMigrationRunner({
    server: () => shared.serverFor("source"),
    bucket: shared.bucket,
    agents: {
      stop: async () => {
        if (++stops === 1) {
          startedFirst();
          await firstGate;
        } else {
          startedSecond();
          await secondGate;
        }
      },
      isRunning: () => false,
      movedAway: () => {},
    },
    workspaceDirectory: () => workspace,
    stateDirectory: join(root, "state"),
    outcomePollMs: 5,
  });
  const grant = lease("source", 0);
  runners.push(runner);
  const first = runner.lease(grant);
  let canceled: Promise<void> | undefined;
  let replacement: Promise<void> | undefined;
  try {
    await firstStarted;
    canceled = runner.cancel({ ...grant, switched: false });
    replacement = runner.lease(grant);
    releaseFirst();
    await secondStarted;
    expect(runner.holds(agentId)).toBe(true);
  } finally {
    releaseFirst();
    releaseSecond();
    await runner.close();
    await Promise.allSettled([first, canceled, replacement].filter(Boolean));
  }
});

test("a stale-generation cancel leaves newer chunks intact", async () => {
  const target = await computer("target", cloud(), "target");
  const chunk = join(target.state, "migrations", migrationId, "2", "chunks", "0.chunk");
  await write(dirname(chunk), { "0.chunk": "newer generation" });
  try {
    await target.runner.cancel({ ...lease("target", 0), switched: false });
    expect(await exists(chunk)).toBe(true);
  } finally {
    await target.runner.close();
  }
});

test("a source never archives a workspace a later migration has placed here meanwhile", async () => {
  const shared = cloud();
  const { source, run } = await uploaded(shared, { "MEMORY.md": "left behind" });
  // Before the source sees the switch, the Agent is moved back here: a later placement now sits in
  // the same directory, with its own commit marker.
  await write(source.workspace, {
    "MEMORY.md": "moved back",
    [AGENT_MIGRATION_COMMIT_MARKER]: JSON.stringify({
      schema: "coforge.agent-migration-commit/v1",
      agentId,
      migrationId: "migration-2",
      generation: 1,
      bundleSha256: "f".repeat(64),
      committedAt: new Date().toISOString(),
    }),
  });
  shared.record.state = "completed";
  await run;
  expect(await readFile(join(source.workspace, "MEMORY.md"), "utf8")).toBe("moved back");
  expect(
    await exists(
      join(source.state, "migration-workspace-backups", agentId, `source-${migrationId}`),
    ),
  ).toBe(false);
});

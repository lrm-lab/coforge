import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_MIGRATION_IGNORE_FILE } from "#src/agent-migration/selection-rules";
import { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import {
  AgentMigrationRemoteError,
  type AgentMigrationBucket,
  type AgentMigrationServer,
  type AgentMigrationState,
  type AgentMigrationView,
} from "#src/agent-migration/transfer-ports";
import type { AgentMigrationBundleManifest } from "#src/agent-migration/bundle-writer";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(prefix: string) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}

const migrationId = "migration-1";
const agentId = "agent-1";

/**
 * The server's side of one migration, shared by both Computers: the fenced state machine the
 * route enforces (each step from its role, at the revision it read) and the steps and failures
 * each Computer reported, in order. `faults` makes the next calls of an operation fail.
 */
function cloud() {
  const record = {
    state: "requested" as AgentMigrationState,
    revision: 0,
    generation: 1,
    manifest: null as AgentMigrationBundleManifest | null,
  };
  const reports: string[] = [];
  const details: (string | undefined)[] = [];
  const objects = new Map<string, Uint8Array>();
  const faults: Record<string, AgentMigrationRemoteError[]> = {};
  const fault = (operation: string) => {
    const error = faults[operation]?.shift();
    if (error) throw error;
  };
  let failUploads = false;
  const advance = (
    expectedRevision: number,
    from: AgentMigrationState,
    to: AgentMigrationState,
  ) => {
    if (record.state === to) return { status: "already_applied" as const };
    if (record.state !== from || record.revision !== expectedRevision)
      throw new AgentMigrationRemoteError("invalid_transition", false);
    record.state = to;
    record.revision++;
    return { status: "advanced" as const };
  };
  const described = () => ({
    id: migrationId,
    state: record.state,
    generation: record.generation,
    revision: record.revision,
  });
  const serverFor = (role: "source" | "target"): AgentMigrationServer => ({
    view: async (): Promise<AgentMigrationView> => {
      fault("view");
      return {
        migration: {
          ...described(),
          agentId,
          role,
          sourceComputerId: "computer-a",
          targetComputerId: "computer-b",
        },
        manifest: record.manifest,
      };
    },
    step: async (input) => {
      reports.push(`${role}:${input.step}`);
      fault(input.step);
      const from: Record<string, AgentMigrationState> = {
        source_stopped: "requested",
        placement_started: "uploaded",
        switch: "placing",
        arrived: "switched",
      };
      const to: Record<string, AgentMigrationState> = {
        source_stopped: "source_stopped",
        placement_started: "placing",
        switch: "switched",
        arrived: "completed",
      };
      return {
        ...advance(input.expectedRevision, from[input.step]!, to[input.step]!),
        migration: described(),
      };
    },
    uploadUrl: async (input) => ({ url: `chunk/${input.chunk.index}`, headers: {} }),
    downloadUrl: async (input) => ({ url: `chunk/${input.index}` }),
    completeUpload: async (input) => {
      reports.push(`${role}:upload_complete`);
      const result = advance(input.expectedRevision, "source_stopped", "uploaded");
      record.manifest = input.manifest;
      return { ...result, migration: described() };
    },
    fail: async (input) => {
      reports.push(`${role}:fail:${input.errorCode}`);
      details.push(input.errorDetail);
      record.state = "failed";
      record.revision++;
      return { status: "failed", migration: described() };
    },
  });
  const bucket: AgentMigrationBucket = {
    put: async (signed, bytes) => {
      if (failUploads) throw new AgentMigrationRemoteError("bucket_refused", false, "403");
      objects.set(signed.url, bytes);
    },
    get: async (url) => {
      const object = objects.get(url);
      if (!object) throw new AgentMigrationRemoteError("bucket_unavailable", true, "404");
      return object;
    },
  };
  return {
    record,
    reports,
    details,
    faults,
    serverFor,
    bucket,
    refuseUploads: () => {
      failUploads = true;
    },
  };
}

async function computer(name: string, shared: ReturnType<typeof cloud>, role: "source" | "target") {
  const root = await temp(`agent-migration-${name}-`);
  const stops: string[] = [];
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
    },
    workspaceDirectory: (id) => join(root, "agents", id),
    stateDirectory: join(root, "state"),
    outcomePollMs: 5,
  });
  return {
    root,
    runner,
    stops,
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
    "work/repo/README.md": "code stays behind",
    ".env": "SECRET=1",
  });
  expect(source.stops).toEqual([agentId]);
  // The ignore file was seeded before selection, so `work/` stayed on the source.
  expect(await readFile(join(source.workspace, AGENT_MIGRATION_IGNORE_FILE), "utf8")).toContain(
    "work",
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
  expect(await exists(join(target.workspace, "work"))).toBe(false);
  expect(await exists(join(target.workspace, ".env"))).toBe(false);
  // The attempt's chunks are gone once the Agent has switched.
  expect(await exists(join(target.state, "migrations", migrationId))).toBe(false);
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

test("a switch the server refuses puts the target's previous workspace back", async () => {
  const shared = cloud();
  const { run } = await uploaded(shared, { "MEMORY.md": "moved" });
  const target = await computer("target", shared, "target");
  await write(target.workspace, { "MEMORY.md": "what was here before" });
  shared.faults.switch = [new AgentMigrationRemoteError("agent_moved", false)];
  await target.runner.lease(lease("target", shared.record.revision));
  expect(shared.reports.at(-1)).toBe("target:fail:agent_moved");
  expect(await readFile(join(target.workspace, "MEMORY.md"), "utf8")).toBe("what was here before");
  expect(await exists(join(target.state, "migrations", migrationId))).toBe(false);
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
  let fetched = 0;
  // The first chunk arrives; every one after it stays unavailable, so the run is mid-download.
  shared.bucket.get = async (url, sizeBytes, signal) => {
    if (fetched++ === 0) return get(url, sizeBytes, signal);
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
  const attempt = join(target.state, "migrations", migrationId);
  await until(() => exists(join(attempt, "1", "chunks", "0.chunk")));
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

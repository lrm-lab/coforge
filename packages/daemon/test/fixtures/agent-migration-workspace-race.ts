import { spyOn } from "bun:test";
import * as fileSystem from "node:fs/promises";
import { join } from "node:path";
import { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import { writeAgentMigrationBundle } from "#src/agent-migration/bundle-writer";
import { selectAgentMigrationWorkspace } from "#src/agent-migration/workspace-selection";
import type { AgentMigrationServer } from "#src/agent-migration/transfer-ports";
import { cloud } from "./agent-migration-cloud";

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error("a temporary root is required");
  const mode = process.argv[3];
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const returningWorkspace = join(root, "returning");
  await fileSystem.mkdir(workspace, { recursive: true });
  await fileSystem.mkdir(returningWorkspace, { recursive: true });
  await Bun.write(join(workspace, "MEMORY.md"), "original workspace");
  await Bun.write(join(returningWorkspace, "MEMORY.md"), "returned workspace");

  const outgoing = cloud({ migrationId: "outgoing", urlPrefix: "outgoing" });
  const returning = cloud({
    migrationId: "returning",
    sourceComputerId: "computer-b",
    targetComputerId: "computer-a",
    urlPrefix: "returning",
  });
  const { manifest } = await writeAgentMigrationBundle({
    workspaceDirectory: returningWorkspace,
    selection: await selectAgentMigrationWorkspace(returningWorkspace),
    onChunk: (chunk) =>
      returning.bucket.put(
        { url: "returning/" + chunk.index, headers: {} },
        chunk.bytes,
        new AbortController().signal,
      ),
  });
  returning.record.manifest = manifest;
  returning.record.state = "uploaded";
  returning.record.revision = 2;
  const outgoingServer = outgoing.serverFor("source");
  const returningServer = returning.serverFor("target");
  const route = (migrationId: string) =>
    migrationId === "outgoing" ? outgoingServer : returningServer;
  const server: AgentMigrationServer = {
    view: (id, signal) => {
      if (id === "outgoing" && outgoing.record.state === "uploaded") {
        outgoing.record.state = "completed";
        outgoing.record.revision = 4;
      }
      return route(id).view(id, signal);
    },
    step: (input, signal) => route(input.migrationId).step(input, signal),
    uploadUrl: (input, signal) => route(input.migrationId).uploadUrl(input, signal),
    downloadUrl: (input, signal) => route(input.migrationId).downloadUrl(input, signal),
    completeUpload: (input, signal) => route(input.migrationId).completeUpload(input, signal),
    fail: (input, signal) => route(input.migrationId).fail(input, signal),
  };
  const runner = new AgentMigrationRunner({
    server: () => server,
    bucket: { put: outgoing.bucket.put, get: returning.bucket.get },
    agents: { stop: async () => {}, isRunning: () => false },
    workspaceDirectory: () => workspace,
    stateDirectory: state,
  });
  const grant = (migrationId: string, role: "source" | "target") => ({
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: "workspace-1",
    computerId: "computer-a",
    agentId: "agent-1",
    migrationId,
    generation: 1,
    role,
    expectedRevision: role === "source" ? 0 : 2,
    expiresInMs: 60_000,
    deadline: Date.now() + 60_000,
  });

  let entered = () => {};
  let release = () => {};
  const archiveEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const archiveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const archived = join(state, "migration-workspace-backups", "agent-1", "source-outgoing");
  const rename = fileSystem.rename;
  const move = spyOn(fileSystem, "rename").mockImplementation(async (from, to) => {
    if (String(from) === workspace && String(to) === archived) {
      entered();
      await archiveGate;
    }
    return rename(from, to);
  });
  let idleState: string | undefined;
  let restoreClock = () => {};
  const onIdle = () => {
    idleState ??= returning.record.state;
    if (mode === "expired") {
      const expiredAt = Date.now() + 60_001;
      const clock = spyOn(Date, "now").mockReturnValue(expiredAt);
      restoreClock = () => clock.mockRestore();
    }
    release();
  };
  const runs: Promise<void>[] = [];
  try {
    runs.push(runner.lease(grant("outgoing", "source")));
    await archiveEntered;
    runs.push(runner.lease(grant("returning", "target")));
    // The old archive is held after its ownership checks. With no other work left, the target
    // has either finished placement or is waiting for that archive; no timer guesses the order.
    // https://bun.com/guides/process/os-signals
    process.once("beforeExit", onIdle);
    await Promise.all(runs);
    const memory = Bun.file(join(workspace, "MEMORY.md"));
    process.stdout.write(
      JSON.stringify({
        idleState,
        outgoingState: outgoing.record.state,
        returningState: returning.record.state,
        lastReport: returning.reports.at(-1),
        memory: (await memory.exists()) ? await memory.text() : null,
        archived: await Bun.file(join(archived, "MEMORY.md")).text(),
      }) + "\n",
    );
  } finally {
    process.off("beforeExit", onIdle);
    release();
    try {
      await runner.close();
      await Promise.allSettled(runs);
    } finally {
      move.mockRestore();
      restoreClock();
    }
  }
}

// Top-level await would keep Bun alive while the two operations wait for the controlled gate.
main().catch((error: unknown) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});

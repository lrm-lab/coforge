import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procJobOwnership, readProcJobIdentity } from "#src/platform/proc-job-process";
import { procJobLedgerPath, readProcJobLedger } from "#src/proc-jobs/proc-job-ledger";
import { ProcJobManager, type ProcJobManagerOptions } from "#src/proc-jobs/proc-job-manager";

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 2_000;
  do {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  } while (performance.now() < deadline);
  throw new Error("Timed out waiting for the fixture");
}

test.each([
  "force",
  "adopt-and-stop",
  "lost-anchor",
  "natural-completion",
  "forget",
  "migration",
  "workspace-delete",
] as const)(
  "%s keeps the slot while a same-group child survives the user command",
  async (mode) => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const directory = await mkdtemp(join(tmpdir(), "coforge-proc-memory-"));
    const options = {
      workspaceId: "ws",
      workspaceRoot: directory,
      stateDirectory: join(directory, "state"),
      maxJobsPerAgent: 1,
      memoryConfigPath: join(directory, "proc.json"),
      systemdMemoryScope: async () => undefined,
      graceMs: 120,
      systemdRunAvailable: async () => false,
      systemdPresentCheck: () => false,
    } satisfies ProcJobManagerOptions;
    let manager = new ProcJobManager(options);
    const children = new Map<number, string>();
    try {
      await mkdir(join(directory, "ws", "agents", "agent"), { recursive: true });
      const childPidPath = join(directory, "child-pid");
      const exitPath = join(directory, "root-exit");
      const childReadyPath = join(directory, "child-ready");
      const { job } = await manager.start({
        agentId: "agent",
        provider: "pi",
        request: {
          name: "surviving-child",
          command: [
            process.execPath,
            "-e",
            `const [childPidPath, exitPath, childReadyPath] = Bun.argv.slice(1);
const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); await Bun.write(Bun.argv[1], ""); await Bun.sleep(8000);', childReadyPath], {
  stdin: "ignore", stdout: "ignore", stderr: "ignore"
});
child.unref();
const readyDeadline = performance.now() + 3000;
while (!(await Bun.file(childReadyPath).exists()) && performance.now() < readyDeadline) await Bun.sleep(20);
await Bun.write(childPidPath, JSON.stringify({ commandPid: process.pid, childPid: child.pid }));
const deadline = performance.now() + 5000;
while (!(await Bun.file(exitPath).exists()) && performance.now() < deadline) await Bun.sleep(20);`,
            childPidPath,
            exitPath,
            childReadyPath,
          ],
        },
      });
      const root = await readProcJobIdentity(job.pid);
      expect(root?.zombie).toBe(false);
      children.set(job.pid, root!.startIdentity);
      const { commandPid, childPid } = await waitFor(async () => {
        const file = Bun.file(childPidPath);
        if (!(await file.exists())) return undefined;
        try {
          const pids = (await file.json()) as { commandPid: number; childPid: number };
          return [pids.commandPid, pids.childPid].every(
            (pid) => Number.isSafeInteger(pid) && pid > 1,
          )
            ? pids
            : undefined;
        } catch {
          return undefined;
        }
      });
      const child = await readProcJobIdentity(childPid);
      expect(child?.pgid).toBe(job.pgid);
      expect(child?.zombie).toBe(false);
      children.set(childPid, child!.startIdentity);

      await Bun.write(exitPath, "");
      await waitFor(async () => {
        const identity = await readProcJobIdentity(commandPid);
        if (!identity || identity.zombie) return true;
        return undefined;
      });
      expect(await readProcJobIdentity(childPid)).toMatchObject({
        pgid: job.pgid,
        startIdentity: child!.startIdentity,
        zombie: false,
      });
      if (mode === "adopt-and-stop") {
        manager.close();
        manager = new ProcJobManager({ ...options, memoryConfigPath: undefined });
      }
      const listing = await manager.list("agent");
      expect(listing.jobs.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: job.id, status: "running" },
      ]);
      await expect(
        manager.start({
          agentId: "agent",
          provider: "pi",
          request: { name: "second", command: [process.execPath, "-e", ""] },
        }),
      ).rejects.toMatchObject({ status: 409 });

      if (mode === "natural-completion") {
        process.kill(childPid, "SIGKILL");
        const exited = await waitFor(async () => {
          const job = (await manager.list("agent")).jobs[0];
          return job?.status === "exited" ? job : undefined;
        });
        expect(exited).toMatchObject({ id: job.id, stopReason: "exited" });
        return;
      }
      if (mode === "lost-anchor") {
        process.kill(job.pid, "SIGKILL");
        await waitFor(async () => {
          const identity = await readProcJobIdentity(job.pid);
          return !identity || identity.zombie ? true : undefined;
        });
        await expect(manager.stop("agent", { name: job.name, force: true })).rejects.toMatchObject({
          status: 500,
        });
        const [record] = await readProcJobLedger(procJobLedgerPath(options.stateDirectory));
        expect(await procJobOwnership(record!, process.platform)).toBe("unknown");
        expect(await readProcJobIdentity(childPid)).toMatchObject({
          startIdentity: child!.startIdentity,
          zombie: false,
        });
        return;
      }
      if (mode === "forget") {
        await manager.forgetAgent("agent", "agent_deleted");
        expect((await manager.list("agent")).jobs).toEqual([]);
      } else if (mode === "migration") {
        const migrated = await manager.stopAllForAgent("agent", "migrated");
        expect(migrated.stopped).toMatchObject([{ id: job.id, stopReason: "migrated" }]);
      } else if (mode === "workspace-delete") {
        await manager.purgeWorkspace();
        expect(await Bun.file(procJobLedgerPath(options.stateDirectory)).exists()).toBe(false);
      } else {
        const stopped = await manager.stop("agent", { name: job.name, force: mode === "force" });
        expect(stopped.stopped).toMatchObject([{ id: job.id, status: "exited" }]);
      }
      await waitFor(async () => {
        const identity = await readProcJobIdentity(childPid);
        if (!identity || identity.zombie) return true;
        return undefined;
      });
    } finally {
      manager.close();
      for (const [pid, startIdentity] of children) {
        if ((await readProcJobIdentity(pid))?.startIdentity !== startIdentity) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  12_000,
);

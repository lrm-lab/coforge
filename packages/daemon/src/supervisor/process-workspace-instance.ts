import { chown, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { isPidAlive } from "#src/platform/process-liveness";

import { WorkspaceHealthJournal, workspaceHealthJournalPath } from "./workspace-health-journal";
import {
  aliasPath,
  ensureWorkspaceIdentity,
  executableForIdentity,
  openTraversalForIdentity,
  resolveSpawnIdentity,
  workspaceDirectory,
  workspaceSharedGid,
  type WorkspaceIdentity,
} from "./workspace-identity";
import { CONTAINER_BINDING_ENV_KEYS } from "./container-binding-env";

const logger = getLogger(["coforge", "daemon", "supervisor"]);
import {
  validateWorkspaceEndpoint,
  type NativeProcessIdentity,
  type WorkspaceInstance,
  type WorkspaceInstanceConfig,
} from "./workspace-instance";

export type ProcessWorkspaceSpawn = (input: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  identity?: WorkspaceIdentity;
}) => Promise<{ pid: number }>;

export type ProcessProbe = (pid: number) => boolean;

export type ProcessSignal = (pid: number, signal?: NodeJS.Signals) => void;

export type ProcessStopTiming = { termGraceMs: number; killConfirmMs: number; pollMs: number };

const DEFAULT_STOP_TIMING: ProcessStopTiming = {
  termGraceMs: 10_000,
  killConfirmMs: 5_000,
  pollMs: 50,
};

export type InstanceRecord = { mainPid: number; invocationId: string };

/** This record's name now that Linux without systemd shares it. */
const RECORD_FILE = "process-instance.json";
/** The name it had while only Windows used this class: a Windows install from before the rename
 * still has the file, so it is read as a fallback and removed on the next write. */
const LEGACY_RECORD_FILE = "windows-instance.json";
const CONTAINER_BINDING_ENV_KEY_SET = new Set<string>(CONTAINER_BINDING_ENV_KEYS);

/**
 * Child-process per-Workspace containment for the MVP: one `__workspace-daemon` OS child per
 * binding, with a durable invocation id under the Workspace state directory so Coordinator
 * recovery can adopt the same instance after a crash. This seam only owns the Workspace
 * daemon process itself.
 */
export class ProcessWorkspaceInstance implements WorkspaceInstance {
  readonly identityKey: string;
  readonly #recordPath: string;
  readonly #legacyRecordPath: string;

  constructor(
    private readonly config: WorkspaceInstanceConfig,
    private readonly spawnChild: ProcessWorkspaceSpawn = defaultSpawn,
    private readonly isAlive: ProcessProbe = isPidAlive,
    private readonly signalProcess: ProcessSignal = defaultSignal,
    private readonly stopTiming: ProcessStopTiming = DEFAULT_STOP_TIMING,
  ) {
    validateWorkspaceEndpoint(config.daemonConnectionEndpoint);
    this.identityKey = new Bun.CryptoHasher("sha256")
      .update(`${config.stateRoot}\0${config.workspaceId}`)
      .digest("hex")
      .slice(0, 24);
    this.#recordPath = join(config.stateDirectory, RECORD_FILE);
    this.#legacyRecordPath = join(config.stateDirectory, LEGACY_RECORD_FILE);
  }

  async ensureStarted(beforeLaunch?: () => Promise<boolean | void>): Promise<number> {
    const current = await this.#readRecord();
    if (current && this.isAlive(current.mainPid)) return current.mainPid;

    await mkdir(this.config.stateDirectory, { recursive: true, mode: 0o700 });
    const volumeRoot = Bun.env.COFORGE_WORKSPACE_VOLUME_ROOT;
    if (volumeRoot) {
      await ensureWorkspaceIdentity({
        stateRoot: this.config.stateRoot,
        workspaceId: this.config.workspaceId,
        volumeRoot,
        directories: [
          workspaceDirectory(volumeRoot, this.config.workspaceId),
          join(volumeRoot, "agent-workspaces", this.config.workspaceId),
          aliasPath(this.config.stateDirectory, volumeRoot),
        ],
      });
    }
    let spawnIdentity = await resolveSpawnIdentity({
      stateRoot: this.config.stateRoot,
      workspaceId: this.config.workspaceId,
      volumeRoot,
    });
    const reachable = (path: string): string =>
      spawnIdentity ? aliasPath(path, volumeRoot) : path;
    // A child that cannot exec the binary dies at spawn and takes the Workspace with it, so the
    // drop only stands if the copy it will exec is reachable for that uid.
    const executable =
      spawnIdentity && volumeRoot
        ? await executableForIdentity({
            executablePath: this.config.executablePath,
            identity: spawnIdentity.identity,
            volumeRoot,
          })
        : this.config.executablePath;
    if (spawnIdentity && !executable) spawnIdentity = undefined;
    if (spawnIdentity && volumeRoot) {
      // The child reads, traverses and writes under these paths; each one it cannot reach shows up
      // as "failed process readiness" instead of a clear permission error.
      const unopened = await openTraversalForIdentity({
        paths: [
          this.config.stateDirectory,
          this.config.socketPath,
          this.config.supervisorSocketPath,
          join(this.config.stateRoot, "upgrade-request-ids.json"),
          this.#recordPath,
        ],
        identity: spawnIdentity.identity,
        volumeRoot,
      });
      if (unopened.length > 0)
        logger.warn("Workspace paths are not reachable for its identity", {
          workspaceId: this.config.workspaceId,
          uid: spawnIdentity.identity.uid,
          unopened,
        });
    }
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(Bun.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !CONTAINER_BINDING_ENV_KEY_SET.has(entry[0]),
        ),
      ),
      COFORGE_DAEMON_HOME: reachable(this.config.stateDirectory),
    };
    if (spawnIdentity) {
      env.HOME = spawnIdentity.directory;
      env.PI_WORKSPACE_DIR = env.HOME;
    }
    if (this.config.supervisorSocketPath) {
      env.COFORGE_SUPERVISOR_SOCKET = reachable(this.config.supervisorSocketPath);
      env.COFORGE_SUPERVISOR_STATE_PATH = reachable(
        join(this.config.stateRoot, "upgrade-request-ids.json"),
      );
    }
    if (this.config.daemonConnectionEndpoint)
      env.COFORGE_DAEMON_CONNECTION_ENDPOINT = this.config.daemonConnectionEndpoint;

    const invocationId = crypto.randomUUID().replaceAll("-", "");
    // The child may write the record before the launcher's write lands, so the file has to belong
    // to the uid *before* it starts; creating it here keeps that write a no-op for ownership.
    if (spawnIdentity) await this.#prepareRecord(spawnIdentity.identity);
    if (beforeLaunch) await beforeLaunch();
    const child = await this.spawnChild({
      command: [
        executable ?? this.config.executablePath,
        "__workspace-daemon",
        "--socket",
        reachable(this.config.socketPath),
        "--state-directory",
        reachable(this.config.stateDirectory),
      ],
      cwd: reachable(this.config.stateDirectory),
      ...(spawnIdentity
        ? {
            identity: {
              uid: spawnIdentity.identity.uid,
              // The shared group carries the `/workspace` write permission; the uid stays this
              // Workspace's own, so the shared area is the only place two Agents can meet.
              gid: workspaceSharedGid() ?? spawnIdentity.identity.gid,
            },
          }
        : {}),
      env: {
        ...env,
        // The child rewrites this record itself once it holds the binding lock, so a Coordinator
        // that dies between spawn and the write below still leaves a discoverable live instance
        // for the next Coordinator to adopt instead of spawning a duplicate beside it.
        COFORGE_WORKSPACE_INSTANCE_RECORD: reachable(this.#recordPath),
        COFORGE_WORKSPACE_INVOCATION_ID: invocationId,
      },
    });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0)
      throw new Error(`Workspace ${this.config.workspaceId} did not start`);
    await this.#writeRecord({ mainPid: child.pid, invocationId });
    // The child rewrites this record under the binding lock. Written by the launcher, it stays
    // root's, and the child then fails to update it: "EACCES ... process-instance.json", which
    // surfaces as "Daemon failed to recover configured Workspace".
    if (spawnIdentity)
      await chown(this.#recordPath, spawnIdentity.identity.uid, spawnIdentity.identity.gid).catch(
        () => undefined,
      );
    return child.pid;
  }

  async stop(): Promise<void> {
    const current = await this.#readRecord();
    let signalled = false;
    if (current && this.isAlive(current.mainPid)) {
      signalled = true;
      try {
        this.signalProcess(current.mainPid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await this.#waitForExit(current.mainPid, this.stopTiming.termGraceMs);
      if (this.isAlive(current.mainPid)) {
        try {
          this.signalProcess(current.mainPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await this.#waitForExit(current.mainPid, this.stopTiming.killConfirmMs);
        if (this.isAlive(current.mainPid))
          throw new Error(
            `Workspace ${this.config.workspaceId} process ${current.mainPid} did not exit after SIGKILL`,
          );
      }
    }
    await rm(this.#recordPath, { force: true });
    await rm(this.#legacyRecordPath, { force: true });
    // A host without a service manager has no Restart unit: Coordinator stop is the intentional
    // lifecycle seam. If SIGKILL beats the child's SIGTERM shutdown, live would stay true and the
    // next start would recordCrash toward the degraded latch. Clear live only when this stop
    // actually signalled a live PID — an already-dead child must keep live so the replacement can
    // count the unexpected death.
    if (signalled) {
      await new WorkspaceHealthJournal(
        workspaceHealthJournalPath(this.config.stateDirectory),
      ).recordGracefulStop();
    }
  }

  async #waitForExit(pid: number, withinMs: number): Promise<void> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline && this.isAlive(pid)) await Bun.sleep(this.stopTiming.pollMs);
  }

  async identity(): Promise<NativeProcessIdentity | null> {
    const current = await this.#readRecord();
    if (!current) return null;
    const active = this.isAlive(current.mainPid);
    return {
      mainPid: current.mainPid,
      active,
      invocationId: current.invocationId,
    };
  }

  async #readRecord(): Promise<InstanceRecord | null> {
    return (await this.#readAt(this.#recordPath)) ?? (await this.#readAt(this.#legacyRecordPath));
  }

  async #readAt(path: string): Promise<InstanceRecord | null> {
    try {
      const bytes = await Bun.file(path).arrayBuffer();
      const text = Buffer.from(bytes).toString("utf8");
      // The record is pre-created so the child owns it before it runs (#591); a zero-byte file is
      // therefore "no record yet", not a corrupt one.
      if (text.trim() === "") return null;
      // Keep UTF-8 bytes explicit: BunFile.text() strips BOMs and detects UTF-16 records.
      const value = JSON.parse(text) as Partial<InstanceRecord>;
      if (
        !Number.isSafeInteger(value.mainPid) ||
        (value.mainPid as number) <= 0 ||
        typeof value.invocationId !== "string" ||
        !/^[0-9a-f]{32}$/i.test(value.invocationId)
      )
        return null;
      return { mainPid: value.mainPid as number, invocationId: value.invocationId.toLowerCase() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #prepareRecord(identity: WorkspaceIdentity): Promise<void> {
    try {
      await writeFile(this.#recordPath, "", { encoding: "utf8", mode: 0o600, flag: "a" });
      await chown(this.#recordPath, identity.uid, identity.gid);
    } catch {
      // A record that cannot be handed over only costs the child's own write; the launcher's
      // write after the spawn still leaves a discoverable instance.
    }
  }

  async #writeRecord(record: InstanceRecord): Promise<void> {
    await writeWorkspaceInstanceRecord(this.#recordPath, record, this.#legacyRecordPath);
  }
}

/**
 * The Workspace child's half of instance discovery: it writes the same record the spawning
 * Coordinator would have, but from inside the lock holder, so the record always names the one
 * daemon allowed to run for the binding. Called only by `__workspace-daemon`; best effort —
 * the Coordinator's own write already covers the ordinary path.
 */
export async function writeWorkspaceInstanceRecord(
  recordPath: string,
  record: InstanceRecord,
  legacyRecordPath?: string,
): Promise<void> {
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // A record read from the old name is superseded, not left to be read again.
  await rm(legacyRecordPath ?? recordPath.replace(RECORD_FILE, LEGACY_RECORD_FILE), {
    force: true,
  });
}

async function defaultSpawn(input: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  identity?: WorkspaceIdentity;
}): Promise<{ pid: number }> {
  const child = Bun.spawn({
    cmd: input.command,
    cwd: input.cwd,
    env: input.env,
    ...(input.identity ? { uid: input.identity.uid, gid: input.identity.gid } : {}),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  // Detach from the Coordinator's lifetime: Workspace children outlive a Coordinator restart.
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("Workspace child did not report a PID");
  return { pid };
}

function defaultSignal(pid: number, signal?: NodeJS.Signals): void {
  process.kill(pid, signal);
}

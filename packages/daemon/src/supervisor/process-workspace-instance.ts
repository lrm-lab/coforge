import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WorkspaceHealthJournal, workspaceHealthJournalPath } from "./workspace-health-journal";
import { CONTAINER_BINDING_ENV_KEYS } from "./container-binding-env";
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
}) => Promise<{ pid: number }>;

export type ProcessProbe = (pid: number) => boolean;

export type ProcessSignal = (pid: number, signal?: NodeJS.Signals) => void;

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
 * recovery can adopt the same instance after a crash. External Agent process trees remain
 * fail-closed in `ProcessTreeOwner` until Job Objects land; this seam only owns the Workspace
 * daemon process itself.
 */
export class ProcessWorkspaceInstance implements WorkspaceInstance {
  readonly identityKey: string;
  readonly #recordPath: string;
  readonly #legacyRecordPath: string;

  constructor(
    private readonly config: WorkspaceInstanceConfig,
    private readonly spawnChild: ProcessWorkspaceSpawn = defaultSpawn,
    private readonly isAlive: ProcessProbe = defaultIsAlive,
    private readonly signalProcess: ProcessSignal = defaultSignal,
  ) {
    validateWorkspaceEndpoint(config.daemonConnectionEndpoint);
    this.identityKey = new Bun.CryptoHasher("sha256")
      .update(`${config.stateRoot}\0${config.workspaceId}`)
      .digest("hex")
      .slice(0, 24);
    this.#recordPath = join(config.stateDirectory, RECORD_FILE);
    this.#legacyRecordPath = join(config.stateDirectory, LEGACY_RECORD_FILE);
  }

  async ensureStarted(): Promise<number> {
    const current = await this.#readRecord();
    if (current && this.isAlive(current.mainPid)) return current.mainPid;

    await mkdir(this.config.stateDirectory, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(Bun.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !CONTAINER_BINDING_ENV_KEY_SET.has(entry[0]),
        ),
      ),
      COFORGE_DAEMON_HOME: this.config.stateDirectory,
    };
    if (this.config.supervisorSocketPath) {
      env.COFORGE_SUPERVISOR_SOCKET = this.config.supervisorSocketPath;
      env.COFORGE_SUPERVISOR_STATE_PATH = join(this.config.stateRoot, "upgrade-request-ids.json");
    }
    if (this.config.daemonConnectionEndpoint)
      env.COFORGE_DAEMON_CONNECTION_ENDPOINT = this.config.daemonConnectionEndpoint;

    const invocationId = crypto.randomUUID().replaceAll("-", "");
    const child = await this.spawnChild({
      command: [
        this.config.executablePath,
        "__workspace-daemon",
        "--socket",
        this.config.socketPath,
        "--state-directory",
        this.config.stateDirectory,
      ],
      cwd: this.config.stateDirectory,
      env: {
        ...env,
        // The child rewrites this record itself once it holds the binding lock, so a Coordinator
        // that dies between spawn and the write below still leaves a discoverable live instance
        // for the next Coordinator to adopt instead of spawning a duplicate beside it.
        COFORGE_WORKSPACE_INSTANCE_RECORD: this.#recordPath,
        COFORGE_WORKSPACE_INVOCATION_ID: invocationId,
      },
    });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0)
      throw new Error(`Workspace ${this.config.workspaceId} did not start`);
    await this.#writeRecord({ mainPid: child.pid, invocationId });
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
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && this.isAlive(current.mainPid)) await Bun.sleep(50);
      if (this.isAlive(current.mainPid)) {
        try {
          this.signalProcess(current.mainPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
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
      // Keep UTF-8 bytes explicit: BunFile.text() strips BOMs and detects UTF-16 records.
      const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<InstanceRecord>;
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
}): Promise<{ pid: number }> {
  const child = Bun.spawn({
    cmd: input.command,
    cwd: input.cwd,
    env: input.env,
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

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSignal(pid: number, signal?: NodeJS.Signals): void {
  process.kill(pid, signal);
}

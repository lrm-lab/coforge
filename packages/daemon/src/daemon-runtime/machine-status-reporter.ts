import { getLogger } from "@logtape/logtape";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  isMachineStatusReportable,
  type MachineStatusReport,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import {
  hostMachineStatusIo,
  readDiskStatus,
  readMachineMemory,
  type MachineStatusIo,
} from "#src/platform/machine-status";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Memory moves; an hour-old figure would be a guess. */
export const MEMORY_REPORT_INTERVAL_MS = 5 * 60_000;
/** Disk use changes slowly, and `statfs` on a network mount can be slow: once an hour is enough. */
export const DISK_REPORT_INTERVAL_MS = 60 * 60_000;

export type MachineStatusPorts = Readonly<{
  connection(): { workspaceId: string; computerId: string };
  /** The Agent data directory: the filesystem Agent workspaces, sessions and state live on. */
  dataDirectory(): string;
  /** The live connection, or undefined while the runtime is not up. */
  transport(): DaemonConnectionClient | undefined;
  platform?: NodeJS.Platform;
  io?: MachineStatusIo;
  now?: () => number;
}>;

/**
 * Reports what this machine has left: the Agent data directory's filesystem and its memory, each
 * on its own timer (and once when the connection comes up). A sample that cannot be read or does
 * not add up is not sent at all — the Computer page shows "unknown" rather than a wrong number.
 */
export class MachineStatusReporter {
  readonly #ports: MachineStatusPorts;
  readonly #io: MachineStatusIo;
  #timers: ReturnType<typeof setInterval>[] = [];
  /** One pass at a time: `statfs` on a slow mount must not pile up behind the next tick. */
  #memoryRunning: Promise<void> | undefined;
  #diskRunning: Promise<void> | undefined;

  constructor(ports: MachineStatusPorts) {
    this.#ports = ports;
    this.#io = ports.io ?? hostMachineStatusIo();
  }

  /** Idempotent; the timers never keep the process alive. */
  start(): void {
    if (this.#timers.length) return;
    void this.reportMemory();
    void this.reportDisk();
    this.#timers = [
      setInterval(() => void this.reportMemory(), MEMORY_REPORT_INTERVAL_MS),
      setInterval(() => void this.reportDisk(), DISK_REPORT_INTERVAL_MS),
    ];
    for (const timer of this.#timers) timer.unref();
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }

  /** Reads and reports memory once; concurrent calls join the one in flight. */
  reportMemory(): Promise<void> {
    this.#memoryRunning ??= this.#report("memory").finally(() => {
      this.#memoryRunning = undefined;
    });
    return this.#memoryRunning;
  }

  /** Reads and reports the data directory's filesystem once; concurrent calls join. */
  reportDisk(): Promise<void> {
    this.#diskRunning ??= this.#report("disk").finally(() => {
      this.#diskRunning = undefined;
    });
    return this.#diskRunning;
  }

  async #report(kind: "disk" | "memory"): Promise<void> {
    const transport = this.#ports.transport();
    if (!transport) return;
    try {
      const sample =
        kind === "disk"
          ? await readDiskStatus(this.#ports.dataDirectory(), this.#io)
          : await readMachineMemory(this.#ports.platform ?? process.platform, this.#io);
      if (!sample || !isMachineStatusReportable(sample) || !this.#ports.transport()) return;
      const owner = this.#ports.connection();
      const report: MachineStatusReport = {
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        workspaceId: owner.workspaceId,
        computerId: owner.computerId,
        reportedAtMs: (this.#ports.now ?? Date.now)(),
        ...sample,
      };
      await (kind === "disk"
        ? transport.sendMachineDiskStatus?.(report)
        : transport.sendMachineMemoryStatus?.(report));
    } catch (error) {
      // Best effort, like every machine figure: the next tick tries again.
      logger.debug("Machine status report failed", {
        event: "machine_status:report_failed",
        kind,
        error_code: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

/** The reporter a runtime builds once: its own identity and data directory are read lazily. */
export function runtimeMachineStatus(ports: {
  connection(): { workspaceId: string; computerId: string };
  dataDirectory(): string;
  transport(): DaemonConnectionClient | undefined;
}): MachineStatusReporter {
  return new MachineStatusReporter({ ...ports, connection: () => ports.connection() });
}

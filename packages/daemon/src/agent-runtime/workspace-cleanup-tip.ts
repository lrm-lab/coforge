import { AGENT_MIGRATION_IGNORE_FILE } from "#src/agent-migration/selection-rules";
import { memoryIndexReminder } from "#src/agent-runtime/agent-memory-seed";
import { statfs } from "node:fs/promises";

export type DiskSpace = Readonly<{ availableBytes: number; totalBytes: number }>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DISK_LOW_MAX_AVAILABLE_BYTES = 20 * 1024 ** 3;
const DISK_LOW_MAX_AVAILABLE_PERCENT = 10;
const TIP_TITLE =
  "When you have time: delete workspace files you are sure are unneeded; ask your owner or creator about unsure ones.";
const TIP_SUMMARY = `Ask only about files new since you last asked. Also keep ${AGENT_MIGRATION_IGNORE_FILE} up to date.`;

type AgentTipState = { lastTipAtMs?: number; lastDiskTipAtMs?: number; diskEpisodeTipped: boolean };

/**
 * Decides when an Agent's next notice carries the workspace cleanup tip. An over-limit MEMORY.md
 * brings it at most once a week; low disk brings it, with how much is free, once per low-disk
 * episode and at most once a week. Process-local, so a daemon restart may repeat the tip early.
 */
export class WorkspaceCleanupTips {
  readonly #agents = new Map<string, AgentTipState>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The launch-time text for the Agent's next notice: its MEMORY.md reminder and the tip. */
  async launchReminder(agentId: string, workspaceDirectory: string): Promise<string | undefined> {
    const [memoryReminder, disk] = await Promise.all([
      memoryIndexReminder(workspaceDirectory),
      measureDiskSpace(workspaceDirectory),
    ]);
    const tip = this.next(agentId, { memoryOverLimit: memoryReminder !== undefined, disk });
    return [memoryReminder, tip].filter(Boolean).join("\n\n") || undefined;
  }

  next(
    agentId: string,
    trigger: { memoryOverLimit: boolean; disk?: DiskSpace },
  ): string | undefined {
    const nowMs = this.now();
    const weekPassed = (atMs?: number) => atMs === undefined || nowMs - atMs >= WEEK_MS;
    const state = this.#agents.get(agentId) ?? { diskEpisodeTipped: false };
    this.#agents.set(agentId, state);
    const lowDisk = trigger.disk && isDiskLow(trigger.disk) ? trigger.disk : undefined;
    if (!lowDisk) state.diskEpisodeTipped = false;
    else if (!state.diskEpisodeTipped && weekPassed(state.lastDiskTipAtMs)) {
      state.diskEpisodeTipped = true;
      state.lastDiskTipAtMs = state.lastTipAtMs = nowMs;
      return `${TIP_TITLE} Disk is low (${formatBytes(lowDisk.availableBytes)} free). ${TIP_SUMMARY}`;
    }
    if (!trigger.memoryOverLimit || !weekPassed(state.lastTipAtMs)) return undefined;
    state.lastTipAtMs = nowMs;
    return `${TIP_TITLE} ${TIP_SUMMARY}`;
  }
}

/** Free and total space of the filesystem holding `path`, or `undefined` when it cannot be read. */
export async function measureDiskSpace(path: string): Promise<DiskSpace | undefined> {
  try {
    const info = await statfs(path);
    return { availableBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  } catch {
    return undefined;
  }
}

function isDiskLow(disk: DiskSpace): boolean {
  return (
    disk.availableBytes < DISK_LOW_MAX_AVAILABLE_BYTES &&
    (disk.availableBytes / disk.totalBytes) * 100 < DISK_LOW_MAX_AVAILABLE_PERCENT
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import { isSafePathScope } from "#src/persistence/path-scope";
import type { MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import { PROC_MEMORY_APP_ID, PROC_MEMORY_NOTICE_CLASS } from "#src/agent-app-inbox/registry";
import type { StoredProcJob } from "./proc-job-ledger";

export type ProcJobMemoryNotice = { jobId: string; agentId: string };

export type PublishProcJobMemoryNotice = (
  agentId: string,
  item: MintAppItem,
  commit: () => Promise<void>,
) => Promise<void>;

const procJobMemoryNoticeSchema = z.object({
  jobId: z.string().regex(RFC_UUID_PATTERN),
  agentId: z.string().refine(isSafePathScope),
});

export function decodeProcJobMemoryNotice(value: unknown): ProcJobMemoryNotice | undefined {
  const parsed = procJobMemoryNoticeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class ProcJobMemoryNotices {
  readonly #pending = new Map<string, ProcJobMemoryNotice>();

  constructor(private readonly publish?: PublishProcJobMemoryNotice) {}

  restore(notices: readonly ProcJobMemoryNotice[]): void {
    for (const notice of notices) this.#pending.set(notice.jobId, notice);
  }

  snapshot(): ProcJobMemoryNotice[] {
    return [...this.#pending.values()];
  }

  add(job: StoredProcJob): void {
    if (job.memory?.termination === "memory_limit")
      this.#pending.set(job.id, { agentId: job.agentId, jobId: job.id });
  }

  forget(agentId: string): void {
    for (const notice of this.#pending.values())
      if (notice.agentId === agentId) this.#pending.delete(notice.jobId);
  }

  async deliver(agentId: string, persist: () => Promise<void>): Promise<void> {
    if (!this.publish) return;
    const notices = this.snapshot().filter((notice) => notice.agentId === agentId);
    if (!notices.length) return;
    await persist();
    for (const notice of notices) {
      const { jobId } = notice;
      await this.publish(
        agentId,
        {
          appId: PROC_MEMORY_APP_ID,
          notificationClass: PROC_MEMORY_NOTICE_CLASS,
          sourceRef: { kind: "proc_job", id: jobId, revision: "1" },
          title: "Background job stopped at its memory cap",
          summary: `Job ${jobId} exceeded its configured memory limit.`,
        },
        async () => {
          this.#pending.delete(jobId);
          try {
            await persist();
          } catch (error) {
            this.#pending.set(jobId, notice);
            throw error;
          }
        },
      );
    }
  }
}

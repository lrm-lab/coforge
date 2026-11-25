import { verifyProcJobGroupAnchor, type ProcJobStopTarget } from "#src/platform/proc-job-process";
import { readProcJobRssGroups, type ProcJobRssGroups } from "#src/platform/proc-job-rss";

export const PROC_JOB_RSS_INTERVAL_MS = 15_000;
const PROC_JOB_RSS_TIMEOUT_MS = 3_000;

export type ProcJobRssTarget = ProcJobStopTarget & {
  id: string;
  groupAnchor: true;
  startIdentity: string;
  limitBytes: number;
};

type RssReading = { id: string; bytes: number | undefined; overLimit: boolean };

type RssSamplerOptions = {
  platform?: NodeJS.Platform;
  now?: () => number;
  timeoutMs?: number;
  readGroups?: (signal: AbortSignal) => Promise<ProcJobRssGroups | undefined>;
  verifyAnchor?: (target: ProcJobRssTarget) => Promise<boolean>;
};

export class ProcJobRssSampler {
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #readGroups: NonNullable<RssSamplerOptions["readGroups"]>;
  readonly #verifyAnchor: NonNullable<RssSamplerOptions["verifyAnchor"]>;
  #previous = new Map<string, string>();
  #lastSampleAt: number | undefined;
  #sampling = false;

  constructor(options: RssSamplerOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => performance.now());
    this.#timeoutMs = options.timeoutMs ?? PROC_JOB_RSS_TIMEOUT_MS;
    this.#readGroups = options.readGroups ?? ((signal) => readProcJobRssGroups(platform, signal));
    this.#verifyAnchor =
      options.verifyAnchor ?? ((target) => verifyProcJobGroupAnchor(target, platform));
  }

  async #read(
    targets: readonly ProcJobRssTarget[],
    signal: AbortSignal,
  ): Promise<Map<string, number>> {
    const bytes = new Map<string, number>();
    const verified: ProcJobRssTarget[] = [];
    for (let offset = 0; offset < targets.length; offset += 16) {
      if (signal.aborted) return bytes;
      const batch = await Promise.all(
        targets.slice(offset, offset + 16).map(async (target) => {
          if (!Number.isSafeInteger(target.limitBytes) || target.limitBytes <= 0) return undefined;
          return (await this.#verifyAnchor(target)) ? target : undefined;
        }),
      );
      verified.push(...batch.filter((target) => target !== undefined));
    }
    if (verified.length === 0 || signal.aborted) return bytes;
    const groups = await this.#readGroups(signal);
    if (!groups) return bytes;
    for (let offset = 0; offset < verified.length; offset += 16) {
      if (signal.aborted) return bytes;
      await Promise.all(
        verified.slice(offset, offset + 16).map(async (target) => {
          if (target.pgid === null) return;
          const group = groups.get(target.pgid);
          if (group?.members.has(target.pid) && (await this.#verifyAnchor(target)))
            bytes.set(target.id, group.bytes);
        }),
      );
    }
    return bytes;
  }

  async sample(targets: readonly ProcJobRssTarget[]): Promise<RssReading[] | undefined> {
    const now = this.#now();
    if (
      this.#sampling ||
      (this.#lastSampleAt !== undefined && now - this.#lastSampleAt < PROC_JOB_RSS_INTERVAL_MS)
    )
      return undefined;
    if (
      this.#lastSampleAt !== undefined &&
      now - this.#lastSampleAt >= 2 * PROC_JOB_RSS_INTERVAL_MS
    )
      this.#previous.clear();
    this.#sampling = true;
    this.#lastSampleAt = now;
    const abort = new AbortController();
    const deadline = performance.now() + this.#timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(undefined);
        }, this.#timeoutMs);
      });
      const bytes = await Promise.race([
        this.#read(targets, abort.signal).catch(() => undefined),
        expired,
      ]);
      const previous = this.#previous;
      this.#previous = new Map();
      const timedOut = abort.signal.aborted || performance.now() >= deadline;
      return targets.map((target) => {
        const reading = timedOut ? undefined : bytes?.get(target.id);
        const exceeded = reading !== undefined && reading > target.limitBytes;
        const identity = JSON.stringify([
          target.pid,
          target.pgid,
          target.startIdentity,
          target.groupAnchorBootId,
          target.limitBytes,
        ]);
        if (exceeded) this.#previous.set(target.id, identity);
        return {
          id: target.id,
          bytes: reading,
          overLimit: exceeded && previous.get(target.id) === identity,
        };
      });
    } finally {
      clearTimeout(timer);
      abort.abort();
      this.#sampling = false;
    }
  }
}

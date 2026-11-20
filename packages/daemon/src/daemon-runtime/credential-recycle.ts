import type { IdleStopResult } from "./agent-config-apply";
import type { ColdIdleAgent } from "./cold-idle-sweep";
import { scheduleUnrefTimer, type UnrefTimerSchedule } from "./unref-timer";

export const CREDENTIAL_RECYCLE_RETRY_MS = 5_000;

export type CredentialRecyclePorts = Readonly<{
  agent(agentId: string): ColdIdleAgent | undefined;
  launching(agentId: string): boolean;
  launchOf(agentId: string): object | undefined;
  stopIdle(agentId: string, options?: Readonly<{ skipWake?: boolean }>): Promise<IdleStopResult>;
  schedule?: UnrefTimerSchedule;
}>;

type Pending = {
  acceptedLaunch: object | undefined;
};

export class CredentialRecycle {
  readonly #ports: CredentialRecyclePorts;
  readonly #schedule: UnrefTimerSchedule;
  readonly #pending = new Map<string, Pending>();
  readonly #stopping = new Map<string, Promise<void>>();
  #cancelTimer: (() => void) | undefined;
  #disposed = false;

  constructor(ports: CredentialRecyclePorts) {
    this.#ports = ports;
    this.#schedule = ports.schedule ?? scheduleUnrefTimer;
  }

  request(agentId: string, options?: Readonly<{ skipWake?: boolean }>): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const live = this.#ports.agent(agentId);
    if (live === undefined && !this.#ports.launching(agentId)) {
      this.#clear(agentId);
      return Promise.resolve();
    }
    const acceptedLaunch = this.#ports.launchOf(agentId);
    this.#pending.set(agentId, { acceptedLaunch });
    return this.settle(agentId, options?.skipWake === true);
  }

  hasPending(agentId: string): boolean {
    if (this.#stopping.has(agentId)) return true;
    const entry = this.#pending.get(agentId);
    if (!entry) return false;
    const launch = this.#ports.launchOf(agentId);
    return launch === undefined || launch === entry.acceptedLaunch;
  }

  stopped(agentId: string): void {
    this.#clear(agentId);
  }

  settle(agentId: string, skipWake = false): Promise<void> {
    const inFlight = this.#stopping.get(agentId);
    if (inFlight) return inFlight;
    const entry = this.#pending.get(agentId);
    if (!entry || this.#disposed) return Promise.resolve();
    const live = this.#ports.agent(agentId);
    if (live === undefined && !this.#ports.launching(agentId)) {
      this.#clear(agentId);
      return Promise.resolve();
    }
    const launch = this.#ports.launchOf(agentId);
    if (launch !== undefined && launch !== entry.acceptedLaunch) {
      this.#clear(agentId);
      return Promise.resolve();
    }
    if (live === undefined || live.busyReason !== undefined || live.sessionId === undefined) {
      this.#arm();
      return Promise.resolve();
    }
    return this.#stopIdle(agentId, entry, skipWake);
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending.clear();
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  #stopIdle(agentId: string, entry: Pending, skipWake: boolean): Promise<void> {
    const stopping = (async () => {
      let result: IdleStopResult;
      try {
        result = await this.#ports.stopIdle(agentId, { skipWake });
      } catch {
        result = "failed";
      } finally {
        this.#stopping.delete(agentId);
      }
      const current = this.#pending.get(agentId);
      if (result === "busy") {
        this.#arm();
        return;
      }
      if (current === entry) this.#clear(agentId);
      else if (current) await this.settle(agentId);
    })();
    this.#stopping.set(agentId, stopping);
    return stopping;
  }

  #clear(agentId: string): void {
    this.#pending.delete(agentId);
    if (this.#pending.size === 0) {
      this.#cancelTimer?.();
      this.#cancelTimer = undefined;
    }
  }

  #arm(): void {
    if (this.#cancelTimer || this.#pending.size === 0 || this.#disposed) return;
    this.#cancelTimer = this.#schedule(async () => {
      this.#cancelTimer = undefined;
      await Promise.all([...this.#pending.keys()].map((agentId) => this.settle(agentId)));
      this.#arm();
    }, CREDENTIAL_RECYCLE_RETRY_MS);
  }
}

import { getDatabaseClient } from "#src/server/db/client.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { getAgentDisplay } from "./agent-display.server";
import { AgentControlEvents } from "./agent-control-events.server";
import { AgentControlPublisher } from "./agent-control-publisher.server";
import { getAgentControlSignal } from "./agent-control-signal.server";
import { AgentControlStartupTimeout } from "./agent-control-startup-timeout.server";
import type {
  AgentControlStartupStore,
  StartupCandidateCursor,
} from "./agent-control-types.server";
import { getAgentRuntimeLock } from "./agent-runtime-lock.server";
import { createAgentStopReasonRecorder } from "./agent-stop-reason.server";

export const STARTUP_SWEEP_INTERVAL_MS = 30_000;
export const STARTUP_SWEEP_BATCH_LIMIT = 50;
export const STARTUP_SWEEP_BATCHES_PER_TICK = 4;
const STARTUP_SWEEP_LOCK_TTL_MS = 120_000;
const STARTUP_SWEEP_LOCK_KEY = "coforge:agent-control:startup-sweep:lock";

export interface AgentControlStartupSweepLock {
  acquire(instanceId: string): Promise<boolean>;
}

type LockRedisPort = {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
};

export class RedisAgentControlStartupSweepLock implements AgentControlStartupSweepLock {
  constructor(private readonly redis: LockRedisPort) {}

  async acquire(instanceId: string): Promise<boolean> {
    const result = await this.redis.set(
      STARTUP_SWEEP_LOCK_KEY,
      instanceId,
      "NX",
      "PX",
      STARTUP_SWEEP_LOCK_TTL_MS,
    );
    return result === "OK";
  }
}

export class AgentControlStartupSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private cursor: StartupCandidateCursor | undefined;

  constructor(
    private readonly deps: {
      store: AgentControlStartupStore;
      timeout: Pick<AgentControlStartupTimeout, "settle">;
      lock: AgentControlStartupSweepLock;
      clock?: () => number;
      instanceId?: string;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), STARTUP_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const instanceId = this.deps.instanceId ?? "startup-sweep";
      if (!(await this.deps.lock.acquire(instanceId))) return;
      const now = (this.deps.clock ?? Date.now)();
      for (let batch = 0; batch < STARTUP_SWEEP_BATCHES_PER_TICK; batch++) {
        const page = await this.deps.store.listStartupCandidates(
          now,
          STARTUP_SWEEP_BATCH_LIMIT,
          this.cursor,
        );
        for (const agentId of page.ids) await this.settleOne(agentId);
        this.cursor = page.next;
        if (!this.cursor) break;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "agent_control_startup_sweep:tick_failed",
          error_type: errorType(error),
        }),
      );
    } finally {
      this.ticking = false;
    }
  }

  private async settleOne(agentId: string): Promise<void> {
    try {
      await this.deps.timeout.settle(agentId);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "agent_control_startup_sweep:agent_failed",
          agent_id: agentId,
          error_type: errorType(error),
        }),
      );
    }
  }
}

let singleton: AgentControlStartupSweep | undefined;
let stopRegistered = false;

function composeStartupSweep(): AgentControlStartupSweep | undefined {
  const db = getDatabaseClient();
  if (!db) return undefined;
  const store = new PrismaAgentControlStore(db);
  const centrifugo = createCentrifugoServerApi();
  const publisher = new AgentControlPublisher(store, centrifugo, Date.now);
  const timeout = new AgentControlStartupTimeout({
    store,
    signal: getAgentControlSignal(),
    events: new AgentControlEvents(centrifugo),
    stopReasons: createAgentStopReasonRecorder({
      display: getAgentDisplay(),
      publishJson: (channel, data) => centrifugo.publishJson(channel, data),
    }),
    runtimeLock: getAgentRuntimeLock(),
    sendStop: async (state) => void (await publisher.sendStop(state)),
    computerOnline: (scope) => getComputerStatusCache().get(scope),
    clock: Date.now,
  });
  const lock = new RedisAgentControlStartupSweepLock(
    openRedisClient(redisUrlFor("the Agent control startup sweep")),
  );
  return new AgentControlStartupSweep({ store, timeout, lock, instanceId: crypto.randomUUID() });
}

export function ensureAgentControlStartupSweep(): void {
  singleton ??= composeStartupSweep();
  if (!singleton) return;
  if (!stopRegistered) {
    stopRegistered = true;
    const sweep = singleton;
    onServerShutdown(() => sweep.stop());
  }
  singleton.start();
}

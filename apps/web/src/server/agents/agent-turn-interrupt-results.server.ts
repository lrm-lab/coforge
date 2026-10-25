import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

const RESULT_TTL_SECONDS = 60;
const READY_CHANNEL = "coforge:agent-turn-interrupt-result-ready:v1";

type Scope = { workspaceId: string; requestId: string };

/**
 * Where a daemon's turn interrupt result reaches the web instance waiting for it. The instance that
 * receives the result is not necessarily the one that published the interrupt.
 */
export interface AgentTurnInterruptResults {
  /** Keeps the first result for a request; a later one for the same request is dropped. */
  put(scope: Scope, result: AgentTurnInterruptResult): Promise<void>;
  /**
   * Resolves with the first stored result `accept` takes, or `"timeout"`. A result written before
   * this call is found too; one `accept` refuses is skipped, not waited out.
   */
  wait(
    scope: Scope,
    timeoutMs: number,
    accept: (result: AgentTurnInterruptResult) => boolean,
  ): Promise<AgentTurnInterruptResult | "timeout">;
}

type Listener = () => void;

type RedisCommands = {
  get(key: string): Promise<string | null>;
  set(...args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
};

type RedisSubscriber = {
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  onconnect: (() => void) | null;
};

/**
 * Result in a key with a TTL, then a notification on a channel. A waiter registers, subscribes,
 * reads the key once (a result stored before the subscription is not missed) and then waits for a
 * notification. One subscription per instance serves every waiter.
 */
export class RedisAgentTurnInterruptResults implements AgentTurnInterruptResults {
  readonly #listeners = new Map<string, Set<Listener>>();
  #subscribed: Promise<unknown> | undefined;

  constructor(
    private readonly redis: RedisCommands,
    private readonly subscriber: RedisSubscriber,
  ) {
    // Bun does not subscribe again after a reconnect, and a notification published while the
    // subscriber was disconnected is lost: subscribe again, then read the keys waiters hold.
    subscriber.onconnect = () => {
      if (!this.#subscribed) return;
      this.#subscribed = undefined;
      void this.#subscribe().then(
        () => {
          for (const listeners of [...this.#listeners.values()])
            for (const listener of [...listeners]) listener();
        },
        () => {},
      );
    };
  }

  async put(scope: Scope, result: AgentTurnInterruptResult) {
    const key = this.#key(scope);
    await this.redis.set(key, JSON.stringify(result), "EX", String(RESULT_TTL_SECONDS), "NX");
    await this.redis.publish(READY_CHANNEL, key);
  }

  async wait(
    scope: Scope,
    timeoutMs: number,
    accept: (result: AgentTurnInterruptResult) => boolean,
  ): Promise<AgentTurnInterruptResult | "timeout"> {
    const key = this.#key(scope);
    let settle!: (value: AgentTurnInterruptResult | "timeout") => void;
    const settled = new Promise<AgentTurnInterruptResult | "timeout">((resolve) => {
      settle = resolve;
    });
    let done = false;
    const check = async () => {
      if (done) return;
      let result: AgentTurnInterruptResult | undefined;
      try {
        result = this.#parse(await this.redis.get(key));
      } catch {
        return;
      }
      if (result && accept(result) && !done) {
        done = true;
        settle(result);
      }
    };
    const timer = setTimeout(() => {
      done = true;
      settle("timeout");
    }, timeoutMs);
    this.#register(key, check);
    try {
      await this.#subscribe();
      await check();
      return await settled;
    } finally {
      clearTimeout(timer);
      this.#unregister(key, check);
    }
  }

  #subscribe() {
    return (this.#subscribed ??= this.subscriber
      .subscribe(READY_CHANNEL, (key) => {
        for (const listener of [...(this.#listeners.get(key) ?? [])]) listener();
      })
      .catch((error: unknown) => {
        this.#subscribed = undefined;
        throw error;
      }));
  }

  #register(key: string, listener: Listener) {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
  }

  #unregister(key: string, listener: Listener) {
    const listeners = this.#listeners.get(key);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.#listeners.delete(key);
  }

  #parse(value: string | null): AgentTurnInterruptResult | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as AgentTurnInterruptResult;
    } catch {
      return undefined;
    }
  }

  #key({ workspaceId, requestId }: Scope) {
    return `${workspaceRedisKey({ workspaceId, name: "agent-turn-interrupt-result", version: "v1" })}:request:${encodeURIComponent(requestId)}`;
  }
}

/** For tests: results live in this process only. */
export class MemoryAgentTurnInterruptResults implements AgentTurnInterruptResults {
  readonly #results = new Map<string, AgentTurnInterruptResult>();
  readonly #listeners = new Set<Listener>();

  async put(scope: Scope, result: AgentTurnInterruptResult) {
    const key = `${scope.workspaceId}:${scope.requestId}`;
    if (!this.#results.has(key)) this.#results.set(key, result);
    for (const listener of [...this.#listeners]) listener();
  }

  wait(
    scope: Scope,
    timeoutMs: number,
    accept: (result: AgentTurnInterruptResult) => boolean,
  ): Promise<AgentTurnInterruptResult | "timeout"> {
    const key = `${scope.workspaceId}:${scope.requestId}`;
    return new Promise((resolve) => {
      const finish = (value: AgentTurnInterruptResult | "timeout") => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(value);
      };
      const check = () => {
        const result = this.#results.get(key);
        if (result && accept(result)) finish(result);
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      this.#listeners.add(check);
      check();
    });
  }
}

let singleton: RedisAgentTurnInterruptResults | undefined;

export function getAgentTurnInterruptResults() {
  const url = redisUrlFor("Agent turn interrupt results");
  return (singleton ??= new RedisAgentTurnInterruptResults(
    openRedisClient(url),
    openRedisClient(url),
  ));
}

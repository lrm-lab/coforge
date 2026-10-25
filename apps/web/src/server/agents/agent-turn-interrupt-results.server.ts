import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

const RESULT_TTL_SECONDS = 60;
const READY_CHANNEL = "coforge:agent-turn-interrupt-result-ready:v1";

type Scope = { workspaceId: string; agentId: string; requestId: string };

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
  del(key: string): Promise<unknown>;
  set(...args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
};

type RedisSubscriber = {
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  send(command: "SUBSCRIBE", args: string[]): Promise<unknown>;
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
    // After a reconnect Bun keeps its listener but the new connection is not subscribed, and a
    // notification published meanwhile is lost: subscribe the connection again (a second
    // `subscribe()` would stack a second listener), then read the keys waiters hold. A failure is
    // retried by the next reconnect.
    subscriber.onconnect = () => {
      void this.#subscribed
        ?.then(() => subscriber.send("SUBSCRIBE", [READY_CHANNEL]))
        .then(
          () => this.#notify(),
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
    // `settle` takes the first value only, so a late check or the timer cannot overwrite it.
    const check = async () => {
      let result: AgentTurnInterruptResult | undefined;
      try {
        result = this.#parse(await this.redis.get(key));
      } catch {
        return;
      }
      if (!result || !accept(result)) return;
      settle(result);
      // Consumed, so a retry of the same request id within the TTL waits for its own result.
      this.redis.del(key).catch(() => {});
    };
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    this.#register(key, check);
    try {
      // A subscribe that hangs while Redis is down must not outlast the timeout.
      await Promise.race([this.#subscribe(), settled]);
      // Not awaited: a read stalled by Redis must not outlast the timeout either.
      void check();
      return await settled;
    } finally {
      clearTimeout(timer);
      this.#unregister(key, check);
    }
  }

  #subscribe() {
    return (this.#subscribed ??= this.subscriber
      .subscribe(READY_CHANNEL, (key) => this.#notify(key))
      .catch((error: unknown) => {
        this.#subscribed = undefined;
        throw error;
      }));
  }

  /** Wakes the waiters of one key, or of every key. */
  #notify(key?: string) {
    const sets = key === undefined ? [...this.#listeners.values()] : [this.#listeners.get(key)];
    for (const listeners of sets) for (const listener of [...(listeners ?? [])]) listener();
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

  /** Scoped to the Agent, so only a result naming the Agent a waiter interrupts can take its key. */
  #key({ workspaceId, agentId, requestId }: Scope) {
    return `${workspaceRedisKey({ workspaceId, agentId, name: "agent-turn-interrupt-result", version: "v1" })}:request:${encodeURIComponent(requestId)}`;
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

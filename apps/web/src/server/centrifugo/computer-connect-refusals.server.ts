import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

/**
 * The last terminal connect refusal per (Workspace, Computer), recorded by the connect proxy
 * when it answers a Daemon for good. A refused Daemon cannot report anything itself, so this
 * record is how the Computers page learns why the binding stopped and what moves it on; the
 * next successful connect clears it. One key per scope holds only the latest refusal: a repeat
 * of the same reason just refreshes `at`.
 */
export type ComputerConnectRefusal = {
  reason: DaemonConnectRejectionReason;
  at: string;
};

export type ComputerConnectRefusals = {
  record(
    scope: { workspaceId: string; computerId: string },
    reason: DaemonConnectRejectionReason,
  ): Promise<void>;
  clear(scope: { workspaceId: string; computerId: string }): Promise<void>;
};

const REFUSAL_TTL_SECONDS = "2592000";

function refusalKey(scope: { workspaceId: string; computerId: string }) {
  return workspaceRedisKey({
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    name: "connect-refusal",
    version: "v1",
  });
}

const computerConnectRefusalSchema = z.object({
  reason: z.string(),
  at: z.string(),
});

export class RedisComputerConnectRefusals implements ComputerConnectRefusals {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      del(key: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      mget(...keys: string[]): Promise<Array<string | null>>;
    },
  ) {}

  async record(
    scope: { workspaceId: string; computerId: string },
    reason: DaemonConnectRejectionReason,
  ) {
    const refusal: ComputerConnectRefusal = { reason, at: new Date().toISOString() };
    await this.redis.set(refusalKey(scope), JSON.stringify(refusal), "EX", REFUSAL_TTL_SECONDS);
  }

  async clear(scope: { workspaceId: string; computerId: string }) {
    await this.redis.del(refusalKey(scope));
  }

  /** One round trip for many scopes; missing or unreadable values read as no refusal. */
  async getMany(scopes: readonly { workspaceId: string; computerId: string }[]) {
    if (scopes.length === 0) return [];
    const values = await this.redis.mget(...scopes.map(refusalKey));
    return values.map((value) => {
      if (!value) return null;
      try {
        const parsed = computerConnectRefusalSchema.safeParse(JSON.parse(value));
        if (parsed.success) return parsed.data as ComputerConnectRefusal;
      } catch {}
      return null;
    });
  }
}

let singleton: RedisComputerConnectRefusals | undefined;

export function getComputerConnectRefusals() {
  if (!singleton) {
    singleton = new RedisComputerConnectRefusals(
      openRedisClient(redisUrlFor("Computer connect refusals")),
    );
  }
  return singleton;
}

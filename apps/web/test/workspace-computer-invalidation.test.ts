import { describe, expect, test } from "bun:test";
import {
  LocalWorkspaceComputerInvalidation,
  RedisWorkspaceComputerInvalidation,
} from "#src/server/agents/workspace-computer-invalidation.server";
import { redisServer, useRedisFixture } from "./helpers/redis-fixture";

describe("LocalWorkspaceComputerInvalidation", () => {
  test("a notify forgets the Computer on every registered cache", () => {
    const signal = new LocalWorkspaceComputerInvalidation();
    const forgotten: (string | undefined)[] = [];
    signal.forgetWith((id) => forgotten.push(id));
    signal.forgetWith((id) => forgotten.push(id));
    signal.notify("computer-1");
    expect(forgotten).toEqual(["computer-1", "computer-1"]);
  });
});

describe.skipIf(!redisServer)("RedisWorkspaceComputerInvalidation", () => {
  const client = useRedisFixture();

  test("a notify on one instance forgets the Computer on another", async () => {
    const writer = new RedisWorkspaceComputerInvalidation(client(), () => client());
    const reader = new RedisWorkspaceComputerInvalidation(client(), () => client());
    const forgotten: (string | undefined)[] = [];
    reader.forgetWith((id) => forgotten.push(id));
    const local: (string | undefined)[] = [];
    writer.forgetWith((id) => local.push(id));
    // Let both subscriptions settle before the notify crosses the wire.
    await Bun.sleep(200);
    writer.notify("computer-7");
    for (let attempt = 0; attempt < 100 && forgotten.length === 0; attempt++) await Bun.sleep(10);
    expect(forgotten).toEqual(["computer-7"]);
    expect(local).toEqual(["computer-7"]);
  });
});

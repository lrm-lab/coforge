import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
  LocalWorkspaceComputerInvalidation,
  RedisWorkspaceComputerInvalidation,
} from "#src/server/agents/workspace-computer-invalidation.server";

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

const redisServer = Bun.which("redis-server");
const port = 20_000 + Math.floor(Math.random() * 20_000);
const url = `redis://127.0.0.1:${port}`;
let process: ReturnType<typeof Bun.spawn> | undefined;
const clients: RedisClient[] = [];
const client = () => {
  const redis = new RedisClient(url);
  clients.push(redis);
  return redis;
};

describe.skipIf(!redisServer)("RedisWorkspaceComputerInvalidation", () => {
  beforeAll(async () => {
    process = Bun.spawn(
      [redisServer!, "--port", String(port), "--save", "", "--appendonly", "no"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const probe = client();
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await probe.send("PING", []);
        return;
      } catch {
        await Bun.sleep(20);
      }
    }
    throw new Error("redis-server did not start");
  });

  afterAll(async () => {
    for (const redis of clients) redis.close();
    process?.kill();
  });

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

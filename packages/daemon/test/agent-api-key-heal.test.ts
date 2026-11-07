import { expect, test } from "bun:test";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { createAgentApiKeyHealer } from "#src/daemon-runtime/agent-api-key-heal";

const KEY_OLD = "sk_agent_old";
const KEY_NEW = "sk_agent_new";

function ports(overrides: {
  keys?: Map<string, string>;
  alive?: boolean;
  mint?: () => Promise<{ agentApiKey: string }>;
  now?: () => number;
}) {
  const keys = overrides.keys ?? new Map([["agent-a", KEY_OLD]]);
  const minted: string[] = [];
  const transport = {
    requestAgentLaunchConfig: async () => {
      minted.push("mint");
      return overrides.mint ? overrides.mint() : { agentApiKey: KEY_NEW };
    },
  } as unknown as DaemonConnectionClient;
  return {
    keys,
    minted,
    healer: createAgentApiKeyHealer({
      agentApiKeys: keys,
      workspaceId: () => "ws-1",
      transport: () => transport,
      launchAlive: () => overrides.alive ?? true,
      ...(overrides.now ? { now: overrides.now } : {}),
    }),
  };
}

test("a rejected key mints once, swaps the registry and answers the fresh key", async () => {
  const { keys, minted, healer } = ports({});
  expect(await healer(KEY_OLD)).toBe(KEY_NEW);
  expect(keys.get("agent-a")).toBe(KEY_NEW);
  expect(minted).toHaveLength(1);
});

test("a second rejection of the same dead key reuses the heal without minting", async () => {
  const { keys, minted, healer } = ports({});
  expect(await healer(KEY_OLD)).toBe(KEY_NEW);
  // A concurrent call that also held KEY_OLD gets its 401 now: same answer, no second mint.
  expect(await healer(KEY_OLD)).toBe(KEY_NEW);
  expect(keys.get("agent-a")).toBe(KEY_NEW);
  expect(minted).toHaveLength(1);
});

test("a stopped Agent's rejection mints nothing", async () => {
  const { minted, healer } = ports({ alive: false });
  expect(await healer(KEY_OLD)).toBeUndefined();
  expect(minted).toHaveLength(0);
});

test("a refused mint — a deleted or stopped Agent — answers undefined", async () => {
  const { minted, healer } = ports({
    mint: () => Promise.reject(new Error("Agent launch is not authorized")),
  });
  expect(await healer(KEY_OLD)).toBeUndefined();
  expect(minted).toHaveLength(1);
});

test("an unknown key and a missing transport mint nothing", async () => {
  const { healer } = ports({});
  expect(await healer("sk_agent_unknown")).toBeUndefined();
  const noTransport = createAgentApiKeyHealer({
    agentApiKeys: new Map([["agent-a", KEY_OLD]]),
    workspaceId: () => "ws-1",
    transport: () => undefined,
    launchAlive: () => true,
  });
  expect(await noTransport(KEY_OLD)).toBeUndefined();
});

test("a managed Agent's refresh carries its remembered launch scope", async () => {
  const calls: unknown[] = [];
  const transport = {
    requestAgentLaunchConfig: async (request: unknown) => {
      calls.push(request);
      return { agentApiKey: KEY_NEW };
    },
  } as unknown as DaemonConnectionClient;
  const healer = createAgentApiKeyHealer({
    agentApiKeys: new Map([["agent-a", KEY_OLD]]),
    workspaceId: () => "ws-1",
    transport: () => transport,
    managedScope: () => ({ requestId: "req-1", controlEpoch: 7, launchId: "launch-1" }),
    launchAlive: () => true,
  });
  expect(await healer(KEY_OLD)).toBe(KEY_NEW);
  expect(calls[0]).toMatchObject({
    agentId: "agent-a",
    workspaceId: "ws-1",
    requestId: "req-1",
    controlEpoch: 7,
    launchId: "launch-1",
  });
});

test("a key a racing launch installed during the mint is kept, not overwritten", async () => {
  const keys = new Map([["agent-a", KEY_OLD]]);
  const transport = {
    requestAgentLaunchConfig: async () => {
      keys.set("agent-a", "sk_agent_racer");
      return { agentApiKey: KEY_NEW };
    },
  } as unknown as DaemonConnectionClient;
  const healer = createAgentApiKeyHealer({
    agentApiKeys: keys,
    workspaceId: () => "ws-1",
    transport: () => transport,
    launchAlive: () => true,
  });
  expect(await healer(KEY_OLD)).toBe("sk_agent_racer");
  expect(keys.get("agent-a")).toBe("sk_agent_racer");
});

test("the heal budget caps mints per Agent", async () => {
  let time = 10_000;
  const keys = new Map([["agent-a", KEY_OLD]]);
  const transport = {
    requestAgentLaunchConfig: async () => ({ agentApiKey: `sk_agent_new_${time}` }),
  } as unknown as DaemonConnectionClient;
  const healer = createAgentApiKeyHealer({
    agentApiKeys: keys,
    workspaceId: () => "ws-1",
    transport: () => transport,
    launchAlive: () => true,
    now: () => time,
  });
  // Each heal swaps the registry key, so the next rejection names the newest one.
  for (let i = 0; i < 3; i += 1) {
    const rejected = keys.get("agent-a")!;
    const minted = `sk_agent_new_${time}`;
    expect(await healer(rejected)).toBe(minted);
    time += 60_000;
  }
  const rejected = keys.get("agent-a")!;
  expect(await healer(rejected)).toBeUndefined();
  expect(keys.get("agent-a")).toBe("sk_agent_new_130000");
});

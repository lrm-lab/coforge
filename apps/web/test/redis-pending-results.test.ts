import { expect, test } from "bun:test";
import {
  decodeAgentContextViewResult,
  encodeAgentContextViewResult,
  type AgentContextViewResult,
  type AgentSkillsListResult,
  AgentWorkspaceDeleteResult,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";

import { RedisAgentContextViewResults } from "#src/server/centrifugo/agent-context-view-results.server";
import {
  RedisAgentWorkspaceDeleteResults,
  RedisAgentWorkspaceFileReadResults,
  RedisAgentWorkspaceFilesListResults,
} from "#src/server/centrifugo/agent-workspace-files-cache.server";
import { RedisAgentSkillsResults } from "#src/server/centrifugo/agent-skills-cache.server";

// Pins the Redis contract of the five "pending request → first valid result" stores: the exact
// keys, commands and TTLs, the base64 result encoding, and that an out-of-scope or unsolicited
// result is dropped. The fake runs the stores' accept script's rule itself (compare the whole
// pending value, then SET NX), so the round trip is checked too.

type Call = [command: string, ...args: string[]];

const ACCEPT_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3], 'NX') and 1 or 0`;

function fakeRedis() {
  const values = new Map<string, string>();
  const calls: Call[] = [];
  return {
    calls,
    /** The lifetime the last stored result was given. */
    resultTtl: undefined as string | undefined,
    values,
    async get(key: string) {
      calls.push(["GET", key]);
      return values.get(key) ?? null;
    },
    async set(...args: string[]) {
      calls.push(["SET", ...args]);
      values.set(args[0]!, args[1]!);
      return "OK";
    },
    async send(command: string, args: string[]) {
      if (command === "DEL") {
        calls.push(["DEL", ...args]);
        for (const key of args) values.delete(key);
        return args.length;
      }
      if (command === "PUBLISH") {
        calls.push(["PUBLISH", ...args]);
        return 0;
      }
      // EVAL script numkeys pendingKey resultKey pendingValue resultValue
      const [script, numKeys, pendingKey, resultKey, pendingValue, resultValue, ttl] = args;
      calls.push(["EVAL", script!, numKeys!, pendingKey!, resultKey!]);
      if (values.get(pendingKey!) !== pendingValue) return 0;
      if (values.has(resultKey!)) return 0;
      values.set(resultKey!, resultValue!);
      this.resultTtl = ttl;
      return 1;
    },
  };
}

const scope = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
};

const listResult: AgentWorkspaceFilesListResult = {
  ...scope,
  dirPath: "src",
  includeHidden: false,
  status: "ok",
  rootPath: "/home/agent",
  entries: [{ name: "a.ts", type: "file", sizeBytes: 3, modifiedAtMs: 1 }],
};
const readResult: AgentWorkspaceFileReadResult = {
  ...scope,
  path: "a.ts",
  status: "ok",
  sizeBytes: 3,
  modifiedAtMs: 1,
  text: "abc",
  contentType: "",
  contentBase64: "",
};
const deleteResult: AgentWorkspaceDeleteResult = { ...scope, status: "ok" };
const skillsResult: AgentSkillsListResult = {
  ...scope,
  provider: "codex",
  scannedAtMs: 1,
  global: { status: "ok", entries: [], directories: [] },
  workspace: { status: "partial", entries: [], directories: [] },
};

const contextViewResult: AgentContextViewResult = {
  ...scope,
  requestId: "ctxv_0123456789abcdef0123456789abcdef",
  messageId: "message-1",
  sessionId: "session-1",
  maxBytes: 1024,
  status: "ok",
  createdAtMs: 1,
  content: new TextEncoder().encode("context"),
  encoding: "identity",
};

type Store<Result> = {
  begin(pending: { request: Result; userId: string; revision: string }): Promise<void>;
  read(requestId: string): Promise<Result | undefined>;
  clear(requestId: string): Promise<void>;
  accept(result: Result): Promise<void>;
};

const cases = [
  {
    name: "Workspace Files list",
    prefix: "coforge:agent-workspace-files:v1:list",
    requestId: "request-1",
    ttl: 30,
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentWorkspaceFilesListResults(redis as never) as unknown as Store<unknown>,
    result: listResult,
    readBack: listResult,
    outOfScope: { ...listResult, dirPath: "other" },
  },
  {
    name: "Workspace file read",
    prefix: "coforge:agent-workspace-files:v1:read",
    requestId: "request-1",
    ttl: 30,
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentWorkspaceFileReadResults(redis as never) as unknown as Store<unknown>,
    result: readResult,
    readBack: readResult,
    outOfScope: { ...readResult, path: "b.ts" },
  },
  {
    name: "Workspace delete",
    prefix: "coforge:agent-workspace-files:v1:delete",
    requestId: "request-1",
    ttl: 30,
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentWorkspaceDeleteResults(redis as never) as unknown as Store<unknown>,
    result: deleteResult,
    readBack: deleteResult,
    outOfScope: { ...deleteResult, agentId: "agent-2" },
  },
  {
    name: "Skills",
    prefix: "coforge:agent-skills:v1",
    requestId: "request-1",
    ttl: 30,
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentSkillsResults(redis as never) as unknown as Store<unknown>,
    result: skillsResult,
    readBack: skillsResult,
    outOfScope: { ...skillsResult, provider: "pi" },
  },
  {
    name: "Agent context view",
    prefix: "coforge:agent-context-view:v0",
    requestId: contextViewResult.requestId,
    // A view outlives the Computer's 25 second restore and the page's 30 second poll.
    ttl: 35,
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentContextViewResults(redis as never) as unknown as Store<unknown>,
    result: contextViewResult,
    // The codec fills in the fields the result left out.
    readBack: decodeAgentContextViewResult(encodeAgentContextViewResult(contextViewResult)),
    outOfScope: { ...contextViewResult, sessionId: "session-2" },
  },
] as const;

for (const { name, prefix, requestId, ttl, create, result, readBack, outOfScope } of cases) {
  const pendingKey = `${prefix}:${requestId}:pending`;
  const resultKey = `${prefix}:${requestId}:result`;

  test(`${name}: begin, accept, read and clear use the pinned keys and commands`, async () => {
    const redis = fakeRedis();
    const store = create(redis);
    const pending = { request: result, userId: "user-1", revision: "rev-1" };

    await store.begin(pending);
    expect(redis.calls).toEqual([["SET", pendingKey, JSON.stringify(pending), "EX", String(ttl)]]);

    redis.calls.length = 0;
    await store.accept(result);
    expect(redis.calls).toEqual([
      ["GET", pendingKey],
      ["EVAL", ACCEPT_SCRIPT, "2", pendingKey, resultKey],
    ]);
    expect(redis.values.get(resultKey)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(redis.resultTtl).toBe(String(ttl));

    redis.calls.length = 0;
    expect(await store.read(requestId)).toEqual(readBack);
    expect(redis.calls).toEqual([["GET", resultKey]]);

    redis.calls.length = 0;
    await store.clear(requestId);
    expect(redis.calls).toEqual([["DEL", pendingKey, resultKey]]);
    expect(await store.read(requestId)).toBeUndefined();
  });

  test(`${name}: an unsolicited or out-of-scope result is dropped, and the first one wins`, async () => {
    const redis = fakeRedis();
    const store = create(redis);

    await store.accept(result);
    expect(redis.calls).toEqual([["GET", pendingKey]]);
    expect(await store.read(requestId)).toBeUndefined();

    await store.begin({ request: result, userId: "user-1", revision: "rev-1" });
    redis.calls.length = 0;
    await store.accept(outOfScope);
    expect(redis.calls).toEqual([["GET", pendingKey]]);
    expect(await store.read(requestId)).toBeUndefined();

    await store.accept(result);
    const first = redis.values.get(resultKey);
    await store.accept(result);
    expect(redis.values.get(resultKey)).toBe(first);
    expect(await store.read(requestId)).toEqual(readBack);
  });
}

// A result is stored only when it names the very request that is pending: every field of the
// request, not only the ones the Agent form happens to vary.
const contextViewScopeMismatches: Array<[string, Partial<AgentContextViewResult>]> = [
  ["protocol major", { protocolMajor: 2 }],
  ["request id", { requestId: "ctxv_fedcba9876543210fedcba9876543210" }],
  ["Workspace", { workspaceId: "workspace-2" }],
  ["Computer", { computerId: "computer-2" }],
  ["Agent", { agentId: "agent-2" }],
  ["message id", { messageId: "message-2" }],
  ["session id", { sessionId: "session-2" }],
  ["max bytes", { maxBytes: 2048 }],
];

for (const [field, change] of contextViewScopeMismatches) {
  test(`Agent context view: a result for another ${field} is dropped`, async () => {
    const redis = fakeRedis();
    const store = new RedisAgentContextViewResults(redis as never);
    await store.begin({ request: contextViewResult, userId: "user-1" });
    expect(await store.accept({ ...contextViewResult, ...change })).toBe(false);
    expect(await store.read(contextViewResult.requestId)).toBeUndefined();
    expect(await store.read(change.requestId ?? contextViewResult.requestId)).toBeUndefined();
  });
}

// The Skills store is the one kind wired for wake-ups: `accept` publishes the requestId on
// `<prefix>:wake` after the result lands, and `wait` resolves on it — locally at once, across
// instances through the subscriber, and for every waiter after a reconnect gap.

function fakeSubscriber() {
  let onMessage: ((message: string) => void) | undefined;
  const client = {
    onconnect: null as (() => void) | null,
    async subscribe(_channel: string, listener: (message: string) => void) {
      onMessage = listener;
      return "OK";
    },
    async send() {
      return 1;
    },
    emit(message: string) {
      onMessage?.(message);
    },
    reconnect() {
      client.onconnect?.();
    },
  };
  return client;
}

const WAKE_CHANNEL = "coforge:agent-skills:v1:wake";

test("Skills wake: a stored result publishes its requestId and wakes the local waiter", async () => {
  const redis = fakeRedis();
  const subscriber = fakeSubscriber();
  const store = new RedisAgentSkillsResults(redis as never, () => subscriber as never);
  await store.begin({ request: skillsResult, userId: "user-1", revision: "rev-1" });

  const waiting = store.wait("request-1", 5_000);
  await store.accept(skillsResult);

  expect(await waiting).toBe(true);
  expect(redis.calls).toContainEqual(["PUBLISH", WAKE_CHANNEL, "request-1"]);
});

test("Skills wake: a notification wakes only its own request's waiters", async () => {
  const redis = fakeRedis();
  const subscriber = fakeSubscriber();
  const store = new RedisAgentSkillsResults(redis as never, () => subscriber as never);

  let firstDone = false;
  const first = store.wait("request-1", 5_000).then((value) => {
    firstDone = true;
    return value;
  });
  const second = store.wait("request-2", 5_000);
  await Bun.sleep(0);

  subscriber.emit("request-2");
  expect(await second).toBe(true);
  await Bun.sleep(10);
  expect(firstDone).toBe(false);

  subscriber.emit("request-1");
  expect(await first).toBe(true);
});

test("Skills wake: a reconnect gap wakes every waiter so it re-reads", async () => {
  const redis = fakeRedis();
  const subscriber = fakeSubscriber();
  const store = new RedisAgentSkillsResults(redis as never, () => subscriber as never);

  const first = store.wait("request-1", 5_000);
  const second = store.wait("request-2", 5_000);
  await Bun.sleep(0);

  subscriber.reconnect();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
});

test("Skills wake: a wait with no notification still ends at its bound", async () => {
  const redis = fakeRedis();
  const subscriber = fakeSubscriber();
  const store = new RedisAgentSkillsResults(redis as never, () => subscriber as never);

  expect(await store.wait("request-1", 20)).toBe(false);
});

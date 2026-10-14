import { expect, test } from "bun:test";
import type {
  AgentSkillsListResult,
  AgentWorkspaceDeleteResult,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";

import {
  RedisAgentWorkspaceDeleteResults,
  RedisAgentWorkspaceFileReadResults,
  RedisAgentWorkspaceFilesListResults,
} from "#src/server/centrifugo/agent-workspace-files-cache.server";
import { RedisAgentSkillsResults } from "#src/server/centrifugo/agent-skills-cache.server";

// Pins the Redis contract of the four "pending request → first valid result" stores: the exact
// keys, commands and TTLs, the base64 result encoding, and that an out-of-scope or unsolicited
// result is dropped. The fake runs the stores' accept script's rule itself (compare the whole
// pending value, then SET NX), so the round trip is checked too.

type Call = [command: string, ...args: string[]];

const ACCEPT_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[2], ARGV[2], 'EX', 30, 'NX') and 1 or 0`;

function fakeRedis() {
  const values = new Map<string, string>();
  const calls: Call[] = [];
  return {
    calls,
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
      // EVAL script numkeys pendingKey resultKey pendingValue resultValue
      const [script, numKeys, pendingKey, resultKey, pendingValue, resultValue] = args;
      calls.push(["EVAL", script!, numKeys!, pendingKey!, resultKey!]);
      if (values.get(pendingKey!) !== pendingValue) return 0;
      if (values.has(resultKey!)) return 0;
      values.set(resultKey!, resultValue!);
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
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentWorkspaceFilesListResults(redis as never) as unknown as Store<unknown>,
    result: listResult,
    outOfScope: { ...listResult, dirPath: "other" },
  },
  {
    name: "Workspace file read",
    prefix: "coforge:agent-workspace-files:v1:read",
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentWorkspaceFileReadResults(redis as never) as unknown as Store<unknown>,
    result: readResult,
    outOfScope: { ...readResult, path: "b.ts" },
  },
  {
    name: "Workspace delete",
    prefix: "coforge:agent-workspace-files:v1:delete",
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentWorkspaceDeleteResults(redis as never) as unknown as Store<unknown>,
    result: deleteResult,
    outOfScope: { ...deleteResult, agentId: "agent-2" },
  },
  {
    name: "Skills",
    prefix: "coforge:agent-skills:v1",
    create: (redis: ReturnType<typeof fakeRedis>) =>
      new RedisAgentSkillsResults(redis as never) as unknown as Store<unknown>,
    result: skillsResult,
    outOfScope: { ...skillsResult, provider: "pi" },
  },
] as const;

for (const { name, prefix, create, result, outOfScope } of cases) {
  const pendingKey = `${prefix}:request-1:pending`;
  const resultKey = `${prefix}:request-1:result`;

  test(`${name}: begin, accept, read and clear use the pinned keys and commands`, async () => {
    const redis = fakeRedis();
    const store = create(redis);
    const pending = { request: result, userId: "user-1", revision: "rev-1" };

    await store.begin(pending);
    expect(redis.calls).toEqual([["SET", pendingKey, JSON.stringify(pending), "EX", "30"]]);

    redis.calls.length = 0;
    await store.accept(result);
    expect(redis.calls).toEqual([
      ["GET", pendingKey],
      ["EVAL", ACCEPT_SCRIPT, "2", pendingKey, resultKey],
    ]);
    expect(redis.values.get(resultKey)).toMatch(/^[A-Za-z0-9+/]+=*$/);

    redis.calls.length = 0;
    expect(await store.read("request-1")).toEqual(result);
    expect(redis.calls).toEqual([["GET", resultKey]]);

    redis.calls.length = 0;
    await store.clear("request-1");
    expect(redis.calls).toEqual([["DEL", pendingKey, resultKey]]);
    expect(await store.read("request-1")).toBeUndefined();
  });

  test(`${name}: an unsolicited or out-of-scope result is dropped, and the first one wins`, async () => {
    const redis = fakeRedis();
    const store = create(redis);

    await store.accept(result);
    expect(redis.calls).toEqual([["GET", pendingKey]]);
    expect(await store.read("request-1")).toBeUndefined();

    await store.begin({ request: result, userId: "user-1", revision: "rev-1" });
    redis.calls.length = 0;
    await store.accept(outOfScope);
    expect(redis.calls).toEqual([["GET", pendingKey]]);
    expect(await store.read("request-1")).toBeUndefined();

    await store.accept(result);
    const first = redis.values.get(resultKey);
    await store.accept(result);
    expect(redis.values.get(resultKey)).toBe(first);
    expect(await store.read("request-1")).toEqual(result);
  });
}

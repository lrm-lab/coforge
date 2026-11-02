import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  encodeLocalSessionExcerptResult,
  encodeLocalSessionSearchResult,
  type LocalSessionExcerptResult,
  type LocalSessionSearchResult,
} from "@lrm/coforge-sdk/internal";
import {
  createLocalSessionExcerptResultMethod,
  createLocalSessionSearchResultMethod,
  RedisLocalSessionSearchResults,
} from "#src/server/centrifugo/local-session-results.server";

type Call = [command: string, ...args: string[]];

function fakeRedis() {
  const values = new Map<string, string>();
  const calls: Call[] = [];
  return {
    values,
    calls,
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
      const [script, numKeys, pendingKey, resultKey, pendingValue, resultValue] = args;
      calls.push(["EVAL", script!, numKeys!, pendingKey!, resultKey!]);
      if (values.get(pendingKey!) !== pendingValue || values.has(resultKey!)) return 0;
      values.set(resultKey!, resultValue!);
      return 1;
    },
  };
}

const search: LocalSessionSearchResult = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  query: "compiler",
  sessions: [],
  scanComplete: true,
  contentSearchComplete: true,
};
const excerpt: LocalSessionExcerptResult = {
  protocolMajor: 1,
  requestId: "request-2",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  provider: "codex",
  sessionId: "session-1",
  cwd: "/work/project",
  status: "ok",
  model: "gpt-5.3-codex",
  updatedAtMs: 1,
  initialRequest: "Repair it",
  recentTurns: [],
};

test("local session Redis correlation rejects mismatches, keeps the first result, and clears", async () => {
  const redis = fakeRedis();
  const store = new RedisLocalSessionSearchResults(redis as never);
  await store.begin({ request: search, userId: "owner-1" });
  expect(redis.calls[0]).toEqual([
    "SET",
    "coforge:local-session-handoff:v1:search:request-1:pending",
    JSON.stringify({ request: search, userId: "owner-1" }),
    "EX",
    "15",
  ]);

  await store.accept({ ...search, query: "other" });
  expect(await store.read(search.requestId)).toBeUndefined();
  await store.accept(search);
  const first = await store.read(search.requestId);
  await store.accept({ ...search, scanComplete: false });
  expect(await store.read(search.requestId)).toEqual(first);
  await store.clear(search.requestId);
  expect(await store.read(search.requestId)).toBeUndefined();
});

test("local session result RPCs accept only their daemon principal scope", async () => {
  for (const [method, bytes] of [
    [createLocalSessionSearchResultMethod, encodeLocalSessionSearchResult(search)],
    [createLocalSessionExcerptResultMethod, encodeLocalSessionExcerptResult(excerpt)],
  ] as const) {
    let accepted = 0;
    const receive = method({ accept: async () => void accepted++ });
    for (const principal of [
      { userId: "", workspaceId: "workspace-1", computerId: "computer-1" },
      { userId: "owner", workspaceId: "other", computerId: "computer-1" },
      { userId: "owner", workspaceId: "workspace-1", computerId: "other" },
      {
        userId: "owner",
        agentId: "agent",
        workspaceId: "workspace-1",
        computerId: "computer-1",
      },
    ])
      expect(await receive(bytes, { principal })).toMatchObject({ code: 403 });
    expect(accepted).toBe(0);
    expect(
      await receive(bytes, {
        principal: {
          userId: "owner",
          workspaceId: "workspace-1",
          computerId: "computer-1",
        },
      }),
    ).toBeInstanceOf(Uint8Array);
    expect(accepted).toBe(1);
  }
});

test("private local session selectors use POST Server Functions", async () => {
  const source = await Bun.file(
    join(import.meta.dir, "../src/features/computers/local-session-handoff.functions.ts"),
  ).text();
  expect(source.match(/createServerFn\(\{ method: "POST" \}\)/g)).toHaveLength(2);
  expect(source).not.toContain('createServerFn({ method: "GET" })');
});

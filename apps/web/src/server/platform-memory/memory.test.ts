import { expect, test } from "bun:test";
import type { MemoryWrite } from "@lrm/coforge-sdk/agent";
import { PlatformMemory } from "./memory";
import { MemoryError, type MemoryEngine, type MemoryHead, type MemoryStore } from "./contract";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const actor = { workspaceId, kind: "agent" as const, agentId };
const write = {
  title: "Deployment",
  content: "Run the tests before publishing",
  kind: "fact" as const,
};
function fixture() {
  const heads = new Map<string, MemoryHead>();
  const receipts = new Map<string, { fingerprint: string; entryId: string; deleted: boolean }>();
  const documents = new Map<string, MemoryWrite>();
  const state = {
    enabled: true,
    available: true,
    writes: 0,
    failedRead: false,
    failedDelete: false,
  };
  const store: MemoryStore = {
    async access(a) {
      return {
        enabled: state.enabled,
        admin: false,
        agentIds: a.kind === "agent" ? [a.agentId] : [agentId],
      };
    },
    async get(ws, id) {
      const h = heads.get(id);
      return h?.workspaceId === ws ? h : null;
    },
    async receipt(ws, key, request) {
      return receipts.get(`${ws}:${key}:${request}`) ?? null;
    },
    async reserve(input) {
      const h = { ...input, id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date() };
      heads.set(h.id, h);
      return h;
    },
    async commit(input) {
      const previous = heads.get(input.head.id);
      if (previous?.revision !== input.expectedRevision) return false;
      heads.set(input.head.id, input.head);
      receipts.set(`${workspaceId}:${input.actor}:${input.requestId}`, {
        fingerprint: input.fingerprint,
        entryId: input.head.id,
        deleted: input.deleted,
      });
      return true;
    },
    async list(input) {
      return {
        entries: [...heads.values()].filter(
          (h) =>
            h.workspaceId === input.workspaceId &&
            h.uri &&
            !h.deletedAt &&
            (!h.expiresAt || h.expiresAt > input.now) &&
            (!input.scope || input.scope === h.scope) &&
            (!h.agentId || input.agentIds.includes(h.agentId)),
        ),
        pageCount: 1,
      };
    },
    async current(ws, uris, ids, now) {
      return [...heads.values()].filter(
        (h) =>
          h.workspaceId === ws &&
          h.uri &&
          uris.includes(h.uri) &&
          !h.deletedAt &&
          (!h.expiresAt || h.expiresAt > now) &&
          (!h.agentId || ids.includes(h.agentId)),
      );
    },
    async searchUris(ws, ids, scope, now) {
      return [...heads.values()]
        .filter(
          (h) =>
            h.workspaceId === ws &&
            h.uri &&
            !h.deletedAt &&
            (!h.expiresAt || h.expiresAt > now) &&
            (!h.agentId || ids.includes(h.agentId)) &&
            (!scope || h.scope === scope),
        )
        .map((h) => h.uri!);
    },
    async sourceAllowed() {
      return true;
    },
  };
  const engine: MemoryEngine = {
    async available() {
      return state.available;
    },
    async write(_ws, uri, content) {
      state.writes++;
      documents.set(uri, content);
    },
    async read(_ws, uri) {
      if (state.failedRead) throw new Error("unverified");
      return documents.get(uri)!;
    },
    async remove(_ws, uri) {
      if (state.failedDelete) throw new Error("offline");
      documents.delete(uri);
    },
    async search(_ws, _roots, _query, currentUris) {
      return [...documents.keys()]
        .filter((uri) => !currentUris || currentUris.includes(uri))
        .slice(0, 40);
    },
  };
  return { service: new PlatformMemory(store, engine), heads, state, documents };
}
async function create(f: ReturnType<typeof fixture>, scope: "agent" | "team" = "agent") {
  const result = await f.service.execute(actor, {
    operation: "create",
    scope,
    requestId: crypto.randomUUID(),
    ...write,
  });
  return result.entries[0]!;
}
test("off leaves the existing runtime alone and does not write to the engine", async () => {
  const f = fixture();
  f.state.enabled = false;
  expect((await f.service.execute(actor, { operation: "status" })).enabled).toBe(false);
  await expect(create(f)).rejects.toThrow("memory_disabled");
  expect(f.state.writes).toBe(0);
});
test("private memory stays with the stable Agent and another Agent sees only shared memory", async () => {
  const f = fixture();
  const entry = await create(f);
  await expect(
    f.service.execute({ ...actor, agentId: otherId }, { operation: "get", id: entry.id }),
  ).rejects.toThrow("memory_not_found");
  expect(
    (await f.service.execute(actor, { operation: "get", id: entry.id })).entries[0]?.content,
  ).toBe(write.content);
  await f.service.execute(actor, {
    operation: "share",
    id: entry.id,
    revision: 1,
    requestId: crypto.randomUUID(),
  });
  const result = await f.service.execute(
    { ...actor, agentId: otherId },
    { operation: "search", query: "release" },
  );
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.scope).toBe("team");
  expect(f.heads.get(entry.id)?.scope).toBe("agent");
});
test("stale search results and deleted memory cannot reappear when remote deletion fails", async () => {
  const f = fixture();
  const entry = await create(f);
  f.state.failedDelete = true;
  const deleted = await f.service.execute(actor, {
    operation: "delete",
    id: entry.id,
    revision: 1,
    requestId: crypto.randomUUID(),
  });
  expect(deleted.deleted).toBe(true);
  expect(deleted.cleanupPending).toBe(true);
  expect(
    (await f.service.execute(actor, { operation: "search", query: "release" })).entries,
  ).toHaveLength(0);
  await expect(f.service.execute(actor, { operation: "get", id: entry.id })).rejects.toThrow(
    "memory_not_found",
  );
});
test("read-back is required before a write becomes visible", async () => {
  const f = fixture();
  f.state.failedRead = true;
  await expect(create(f)).rejects.toThrow();
  expect([...f.heads.values()].every((h) => h.revision === 0)).toBe(true);
});
test("replayed writes do not duplicate memory and changed payloads conflict", async () => {
  const f = fixture();
  const command = {
    operation: "create" as const,
    scope: "agent" as const,
    requestId: crypto.randomUUID(),
    ...write,
  };
  const first = await f.service.execute(actor, command);
  expect((await f.service.execute(actor, command)).entries[0]?.id).toBe(first.entries[0]?.id);
  expect(f.state.writes).toBe(1);
  await expect(
    f.service.execute(actor, { ...command, content: "different" }),
  ).rejects.toBeInstanceOf(MemoryError);
});
test("optimistic revisions prevent a stale editor overwriting a newer correction", async () => {
  const f = fixture();
  const entry = await create(f);
  const correction = {
    operation: "update" as const,
    id: entry.id,
    revision: 1,
    requestId: crypto.randomUUID(),
    ...write,
    content: "Use the new deployment procedure",
  };
  expect((await f.service.execute(actor, correction)).entries[0]?.revision).toBe(2);
  await expect(
    f.service.execute(actor, { ...correction, requestId: crypto.randomUUID() }),
  ).rejects.toThrow("memory_conflict");
  expect(
    (await f.service.execute(actor, { operation: "search", query: "release" })).entries[0]?.content,
  ).toBe(correction.content);
});
test("an Agent cannot select a different Agent's namespace or write another author's team memory", async () => {
  const f = fixture();
  const entry = await create(f, "team");
  await expect(f.service.execute(actor, { operation: "list", agentId: otherId })).rejects.toThrow(
    "memory_forbidden",
  );
  await expect(
    f.service.execute(
      { ...actor, agentId: otherId },
      { operation: "delete", id: entry.id, revision: 1, requestId: crypto.randomUUID() },
    ),
  ).rejects.toThrow("memory_forbidden");
});

test("failed cleanup and many obsolete revisions cannot crowd current memory out of recall", async () => {
  const f = fixture();
  f.state.failedDelete = true;
  let entry = await create(f);
  for (let i = 0; i < 45; i++)
    entry = (
      await f.service.execute(actor, {
        operation: "update",
        id: entry.id,
        revision: entry.revision,
        requestId: crypto.randomUUID(),
        ...write,
        content: `Current release procedure ${i}`,
      })
    ).entries[0]!;
  const recalled = await f.service.execute(actor, { operation: "search", query: "release" });
  expect(recalled.entries.map((e) => e.content)).toEqual(["Current release procedure 44"]);
});

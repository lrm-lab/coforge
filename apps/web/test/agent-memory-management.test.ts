import type { AgentMemoryRequest } from "@lrm/coforge-sdk/internal";
import { expect, test } from "bun:test";
import { AgentMemoryManagement } from "#src/server/agents/agent-memory-management.server";
const id = "00000000-0000-4000-8000-000000000001";
const viewer = { workspaceId: id, userId: id };
test("personal memory refuses non-owners before any Computer request", async () => {
  let publishes = 0;
  const query = new AgentMemoryManagement({
    findOwned: async () => undefined,
    online: async () => true,
    supported: async () => true,
    publish: async () => {
      publishes++;
    },
    results: { begin: async () => {}, read: async () => undefined, clear: async () => {} },
  });
  expect(await query.execute(viewer, id, { operation: "list" })).toEqual({ status: "forbidden" });
  expect(publishes).toBe(0);
});
test("personal memory is reauthorized after the reply and always clears transient results", async () => {
  let reads = 0,
    clears = 0;
  let request: AgentMemoryRequest | undefined;
  const query = new AgentMemoryManagement({
    findOwned: async () => (++reads === 1 ? { computerId: id, revision: "one" } : undefined),
    online: async () => true,
    supported: async () => true,
    publish: async (value) => {
      request = value;
    },
    results: {
      begin: async () => {},
      read: async () => {
        if (!request) throw new Error("request not published");
        return { ...request, status: "ok", result: { entries: [] } };
      },
      clear: async () => {
        clears++;
      },
    },
  });
  expect(await query.execute(viewer, id, { operation: "list" })).toEqual({ status: "forbidden" });
  expect(clears).toBe(1);
});
test("old or offline Computers do not receive personal memory operations", async () => {
  let publishes = 0;
  const ports = {
    findOwned: async () => ({ computerId: id, revision: "one" }),
    online: async () => false,
    supported: async () => true,
    publish: async () => {
      publishes++;
    },
    results: { begin: async () => {}, read: async () => undefined, clear: async () => {} },
  };
  expect(await new AgentMemoryManagement(ports).execute(viewer, id, { operation: "list" })).toEqual(
    { status: "offline" },
  );
  expect(
    await new AgentMemoryManagement({
      ...ports,
      online: async () => true,
      supported: async () => false,
    }).execute(viewer, id, { operation: "list" }),
  ).toEqual({ status: "unsupported" });
  expect(publishes).toBe(0);
});

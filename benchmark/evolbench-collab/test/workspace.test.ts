import { expect, test } from "bun:test";
import { provisionEvalWorkspace } from "../src/workspace";
import type { PrismaClient } from "../../../apps/web/src/generated/prisma/client";

test("failed identity provisioning releases the frozen account and owned rows", async () => {
  let bound = false;
  const deleted: string[] = [];
  let agent = 0;
  const db = {
    user: {
      async create() {
        return { id: "owner" };
      },
      async delete() {
        deleted.push("owner");
      },
    },
    workspace: {
      async create() {
        return { id: "workspace", slug: "eval" };
      },
      async delete() {
        bound = false;
        deleted.push("workspace");
      },
    },
    computer: {
      async create() {
        return { id: "computer" };
      },
      async delete() {
        deleted.push("computer");
      },
    },
    agent: {
      async create() {
        return { id: `agent-${agent++}` };
      },
    },
    conversation: {
      async create() {
        return { id: "channel" };
      },
    },
    conversationMember: { async create() {} },
    workspaceMemoryAgent: { async create() {} },
    workspaceMemoryProfile: {
      async findUnique() {
        return null;
      },
      async create() {},
    },
    openVikingBinding: {
      async findUnique() {
        return null;
      },
      async create() {
        bound = true;
      },
    },
    openVikingMappedIdentity: {
      async create() {
        throw new Error("identity write failed");
      },
    },
    async $transaction(callback: (transaction: unknown) => unknown) {
      return callback(db);
    },
  } as unknown as PrismaClient;
  await expect(
    provisionEvalWorkspace({
      db,
      arm: "warm",
      familyId: "ir",
      benchmark: "evoagentbench",
      ovAccountId: "frozen",
    }),
  ).rejects.toThrow("identity write failed");
  expect(bound).toBe(false);
  expect(deleted).toEqual(["workspace", "computer", "owner"]);
});

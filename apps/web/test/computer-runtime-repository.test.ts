import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";

function recordingTransaction() {
  const calls: Array<{ operation: string; args: unknown }> = [];
  const transaction = {
    workspaceComputer: {
      findUnique: async (args: unknown) => {
        calls.push({ operation: "findConnection", args });
        return { id: "connection-1" };
      },
    },
    computerRuntime: {
      deleteMany: async (args: unknown) => calls.push({ operation: "deleteRuntimes", args }),
      upsert: async (args: unknown) => calls.push({ operation: "upsertRuntime", args }),
    },
    computerModelCatalog: {
      deleteMany: async (args: unknown) => calls.push({ operation: "deleteCatalogs", args }),
      upsert: async (args: unknown) => calls.push({ operation: "upsertCatalog", args }),
    },
  };
  const db = {
    $transaction: async (execute: (tx: typeof transaction) => Promise<void>) =>
      execute(transaction),
  } as unknown as PrismaClient;
  return { db, calls };
}

describe("PrismaComputerRuntimeRepository", () => {
  test("keeps a failed provider's last-known catalog instead of clearing the whole Computer", async () => {
    const { db, calls } = recordingTransaction();

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [
        { provider: "codex", version: "1", displayName: "Codex" },
        { provider: "cursor", version: "2", displayName: "Cursor" },
      ],
      [{ provider: "codex", models: [] }],
    );

    // Cursor is still an installed runtime but reported no catalog this round (a probe failure);
    // its last-known row must survive. Only providers that are no longer installed are removed.
    expect(calls).toContainEqual({
      operation: "deleteCatalogs",
      args: {
        where: {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: { notIn: ["codex", "cursor"] },
        },
      },
    });
    expect(calls).toContainEqual({
      operation: "upsertCatalog",
      args: {
        where: {
          workspaceId_computerId_provider: {
            workspaceId: "workspace-1",
            computerId: "computer-1",
            provider: "codex",
          },
        },
        create: {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: "codex",
          models: [],
        },
        update: { models: [], observedAt: expect.any(Date) },
      },
    });
    expect(calls.some((call) => call.operation === "createCatalogs")).toBe(false);
  });

  test("replaces inventory only inside the trusted Workspace-Computer scope", async () => {
    const { db, calls } = recordingTransaction();

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [{ provider: "codex", version: "1", displayName: "Codex" }],
      [{ provider: "codex", models: [] }],
    );

    expect(calls).toContainEqual({
      operation: "findConnection",
      args: {
        where: {
          workspaceId_computerId: { workspaceId: "workspace-1", computerId: "computer-1" },
        },
        select: { id: true },
      },
    });
    expect(calls).toContainEqual({
      operation: "upsertRuntime",
      args: {
        where: {
          workspaceId_computerId_provider: {
            workspaceId: "workspace-1",
            computerId: "computer-1",
            provider: "codex",
          },
        },
        create: {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: "codex",
          version: "1",
          displayName: "Codex",
          unavailableCode: null,
          diagnostic: null,
        },
        update: {
          version: "1",
          displayName: "Codex",
          unavailableCode: null,
          diagnostic: null,
          observedAt: expect.any(Date),
        },
      },
    });
  });

  test("keeps an unusable runtime's row and reason, and drops its stale catalog", async () => {
    const { db, calls } = recordingTransaction();

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [
        { provider: "codex", version: "1", displayName: "Codex" },
        {
          provider: "dsh",
          version: "",
          displayName: "DeepSeek Harness",
          unavailableCode: "start_failed",
          diagnostic: "No version is set for shim: node",
        },
      ],
      [],
    );

    expect(calls).toContainEqual({
      operation: "upsertRuntime",
      args: expect.objectContaining({
        create: expect.objectContaining({
          provider: "dsh",
          unavailableCode: "start_failed",
          diagnostic: "No version is set for shim: node",
        }),
      }),
    });
    // The unusable runtime is still installed, so its row stays; only its stale models go.
    expect(calls).toContainEqual({
      operation: "deleteCatalogs",
      args: {
        where: {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: { notIn: ["codex"] },
        },
      },
    });
  });

  test("drops every catalog once no runtime remains installed", async () => {
    const { db, calls } = recordingTransaction();

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [],
      [],
    );

    expect(calls).toContainEqual({
      operation: "deleteCatalogs",
      args: { where: { workspaceId: "workspace-1", computerId: "computer-1" } },
    });
  });

  test("inheritFromSibling copies another Workspace's inventory onto a fresh link", async () => {
    const created: unknown[] = [];
    const observedAt = new Date("2026-11-09T08:00:00.000Z");
    const db = {
      computerRuntime: {
        count: async () => 0,
        findFirst: async () => ({ workspaceId: "workspace-old" }),
        findMany: async () => [
          {
            provider: "pi",
            version: "1.5.0",
            displayName: "Pi",
            unavailableCode: null,
            diagnostic: null,
            isPublic: true,
            observedAt,
          },
        ],
        create: async (args: unknown) => created.push({ table: "runtime", args }),
      },
      computerModelCatalog: {
        findMany: async () => [
          { provider: "pi", models: [{ id: "muse-spark" }], observedAt },
        ],
        create: async (args: unknown) => created.push({ table: "catalog", args }),
      },
      $transaction: async (execute: (tx: typeof db) => Promise<void>) => execute(db),
    } as unknown as PrismaClient;

    const copied = await new PrismaComputerRuntimeRepository(db).inheritFromSibling(
      "workspace-new",
      "computer-1",
    );

    expect(copied).toBe(1);
    expect(created).toEqual([
      {
        table: "runtime",
        args: {
          data: {
            workspaceId: "workspace-new",
            computerId: "computer-1",
            provider: "pi",
            version: "1.5.0",
            displayName: "Pi",
            unavailableCode: null,
            diagnostic: null,
            isPublic: false,
            observedAt,
          },
        },
      },
      {
        table: "catalog",
        args: {
          data: {
            workspaceId: "workspace-new",
            computerId: "computer-1",
            provider: "pi",
            models: [{ id: "muse-spark" }],
            observedAt,
          },
        },
      },
    ]);
  });

  test("inheritFromSibling is a no-op when the Workspace already has inventory", async () => {
    const db = {
      computerRuntime: {
        count: async () => 2,
        findFirst: async () => {
          throw new Error("must not look up a sibling");
        },
      },
    } as unknown as PrismaClient;
    expect(await new PrismaComputerRuntimeRepository(db).inheritFromSibling("ws", "pc")).toBe(0);
  });
});

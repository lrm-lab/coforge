import { expect, test } from "bun:test";

import type { Prisma } from "#src/generated/prisma/client";
import { recordAgentRuntimeConfigChanged } from "#src/server/app-notifications/agent-events.server";
import {
  recordChannelMembersAdded,
  recordThreadCreatedByReply,
} from "#src/server/app-notifications/channel-events.server";
import { recordComputerVersionChanged } from "#src/server/app-notifications/computer-events.server";
import { defineEmitterCases } from "./helpers/app-notification-emitter-cases";
import { emitterDatabaseUrl } from "./helpers/app-notification-emitters";

/**
 * An emitter never aborts the domain write around it: a query of its own that fails inside the
 * transaction (a failure PostgreSQL answers by aborting the transaction) is rolled back to a
 * savepoint, the write after it commits, and nothing is recorded. Against local PostgreSQL;
 * skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at it.
 */
const environment = defineEmitterCases([]);
const testWithDatabase = emitterDatabaseUrl ? test : test.skip;

/** `tx`, whose `model.method` runs a statement that fails in the database, as a broken query does. */
function failing(
  tx: Prisma.TransactionClient,
  model: keyof Prisma.TransactionClient,
  method: string,
) {
  return new Proxy(tx, {
    get(target, property) {
      if (property === model)
        return new Proxy(Reflect.get(target, property) as object, {
          get: (delegate, name) =>
            name === method
              ? async () => {
                  await target.$queryRaw`SELECT 1/0`;
                }
              : Reflect.get(delegate, name),
        });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Renames the Workspace, runs `emit` against a `tx` with a failing query, renames it again, and
 * returns the name the committed row ends with. */
async function nameAfter(
  env: ReturnType<typeof environment>,
  workspaceId: string,
  emit: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
  await env.db.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { name: "before" } });
    await emit(tx);
    await tx.workspace.update({ where: { id: workspaceId }, data: { name: "after" } });
  });
  return (await env.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).name;
}

testWithDatabase("a failing first-reply check does not abort the send's transaction", async () => {
  const env = environment();
  const fixture = await env.fixture();
  try {
    const reply = {
      workspaceId: fixture.workspace.id,
      channelId: crypto.randomUUID(),
      threadRootId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
    };
    const name = await nameAfter(env, fixture.workspace.id, (tx) =>
      recordThreadCreatedByReply(failing(tx, "message", "findFirst"), reply),
    );
    expect(name).toBe("after");
    expect(await env.recorded(fixture.workspace.id, "thread.created")).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

testWithDatabase("a failing slug read does not abort the transaction", async () => {
  const env = environment();
  const fixture = await env.fixture();
  try {
    const name = await nameAfter(env, fixture.workspace.id, (tx) =>
      recordChannelMembersAdded(
        failing(tx, "workspace", "findUnique"),
        fixture.workspace.id,
        crypto.randomUUID(),
        [{ userId: fixture.owner.id }],
      ),
    );
    expect(name).toBe("after");
    expect(await env.recorded(fixture.workspace.id, "channel.member_added")).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

testWithDatabase(
  "a failing read of a Computer's Workspaces does not abort the transaction",
  async () => {
    const env = environment();
    const fixture = await env.fixture();
    try {
      const name = await nameAfter(env, fixture.workspace.id, (tx) =>
        recordComputerVersionChanged(
          failing(tx, "workspaceComputer", "findMany"),
          crypto.randomUUID(),
          {
            previous: "1.0.0",
            version: "2.0.0",
          },
        ),
      );
      expect(name).toBe("after");
      expect(await env.recorded(fixture.workspace.id, "computer.version_changed")).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
);

testWithDatabase("building an event that fails records nothing and throws nothing", async () => {
  const env = environment();
  const fixture = await env.fixture();
  try {
    const name = await nameAfter(env, fixture.workspace.id, (tx) =>
      recordAgentRuntimeConfigChanged(
        tx,
        fixture.workspace.id,
        crypto.randomUUID(),
        "not a config",
        {
          runtime: "pi",
          model: "m",
          modelProvider: "",
          reasoning: "",
        },
      ),
    );
    expect(name).toBe("after");
    expect(await env.recorded(fixture.workspace.id, "agent.model_changed")).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

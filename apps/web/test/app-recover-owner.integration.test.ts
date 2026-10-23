import { expect, test } from "bun:test";

import { ActionCardError } from "#src/server/conversations/action-cards.server";
import { db, refusal, registerShareFixture } from "./share-link-fixture";
import { fixture } from "./app-agent-management-fixture";

/**
 * The `app:recover_owner` card (`coforge app prepare recover-owner`), against local PostgreSQL with
 * migrations applied: prepared only for an app with no live owner Agent by an admin-role Agent,
 * committed by a Workspace owner or admin once.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
registerShareFixture();

test.skipIf(!db)(
  "recover-owner: a card only while no live owner Agent, committed by an admin",
  async () => {
    const f = await fixture(db!);
    try {
      // An active owner: the card is refused.
      expect(await f.prepareRecover(f.boss.id, f.spare.name).catch((e) => e)).toMatchObject({
        code: "APP_OWNER_ACTIVE",
        status: 409,
      });
      await f.archive(f.scout);
      // A plain Agent does not manage the app; an unknown Agent is not named.
      const plain = await f.prepareRecover(f.other.id, f.spare.name).catch((e) => e);
      expect(plain).toBeInstanceOf(ActionCardError);
      expect(plain).toMatchObject({ code: "INVALID_HANDLE", field: "--client" });
      expect(await f.prepareRecover(f.boss.id, "nobody").catch((e) => e)).toMatchObject({
        code: "INVALID_HANDLE",
        field: "--to-agent",
      });

      const { messageId } = await f.prepareRecover(f.boss.id, `@${f.spare.name}`);
      const actor = (role: "owner" | "admin" | "member") => ({
        workspaceId: f.ws.id,
        userId: f.ws.people[role].id,
      });
      const view = (role: "admin" | "member") =>
        f.cards.viewsFor(f.ws.id, f.ws.people[role].id, [messageId]).then((v) => v.get(messageId));
      expect(await view("admin")).toMatchObject({
        kind: "app:recover_owner",
        canCommit: true,
        app: { key: f.key, name: "Acme Notes" },
        toAgent: { name: f.spare.name },
      });
      expect(await view("member")).toMatchObject({ canCommit: false });

      expect(await refusal(f.recover.commit(actor("member"), messageId))).toMatchObject({
        code: "ACCESS_DENIED",
      });
      expect((await f.app()).ownerAgentId).toBe(f.scout.id);

      await f.recover.commit(actor("admin"), messageId);
      expect((await f.app()).ownerAgentId).toBe(f.spare.id);
      expect(await view("admin")).toMatchObject({
        state: "executed",
        result: { clientKey: f.key, ownerAgent: f.spare.name },
      });
      expect(await refusal(f.recover.commit(actor("owner"), messageId))).toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("recover-owner commit refuses once an owner is live again", async () => {
  const f = await fixture(db!);
  try {
    await f.archive(f.scout);
    const { messageId } = await f.prepareRecover(f.boss.id, f.spare.name);
    // Someone set a live owner in between.
    await db!.app.update({ where: { key: f.key }, data: { ownerAgentId: f.other.id } });
    expect(
      await refusal(
        f.recover.commit({ workspaceId: f.ws.id, userId: f.ws.people.admin.id }, messageId),
      ),
    ).toEqual({ code: "CONFLICT", errorId: "app-owner-active" });
    expect((await f.app()).ownerAgentId).toBe(f.other.id);
    expect((await db!.actionCard.findUniqueOrThrow({ where: { messageId } })).state).toBe(
      "pending",
    );
  } finally {
    await f.cleanup();
  }
});

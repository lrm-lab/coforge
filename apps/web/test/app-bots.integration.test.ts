import { describe, expect, test } from "bun:test";

import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { removeAppInstallations } from "#src/server/db/repositories/app-installation.repositories.server";
import { db, fixture, granted, refusal, tokenRequest, useBotHarness } from "./app-bots-harness";

/**
 * An app's bot against local PostgreSQL with migrations applied: declare by the app's developer,
 * grant and revoke by a Workspace's owner or admin, what each step does and refuses, and what
 * uninstalling or deleting the app does to its bots.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
useBotHarness();

describe.skipIf(!db)("declare (step 1)", () => {
  test("an owner or admin declares the bot; a member cannot, and another Workspace's app is not found", async () => {
    const f = await fixture({ enableBot: false });
    expect((await refusal(f.bots.declare(f.actor("member"), f.key, true))).code).toBe(
      "ACCESS_DENIED",
    );
    await f.bots.declare(f.actor("admin"), f.key, true);
    expect((await db!.app.findUniqueOrThrow({ where: { key: f.key } })).enableBot).toBe(true);
    const other = await fixture({ enableBot: false });
    expect((await refusal(f.bots.declare(other.actor("owner"), f.key, true))).code).toBe(
      "NOT_FOUND",
    );
  });

  test("declaring creates no bot anywhere", async () => {
    const f = await fixture();
    expect(await f.botRow()).toBeNull();
    expect(await db!.agent.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });

  test("turning it off revokes every grant, disables the bots and ends their keys in one change", async () => {
    const f = await granted();
    const first = await (await tokenRequest(f.installationId, f.basic, {})).json();
    const second = await fixture({ enableBot: false });
    // The same app installed in a second Workspace, with its own grant.
    const installed = await db!.appInstallation.create({
      data: {
        appId: (await db!.app.findUniqueOrThrow({ where: { key: f.key } })).id,
        workspaceId: second.workspaceId,
      },
    });
    await db!.app.update({ where: { key: f.key }, data: { enableBot: true } });
    await f.bots.grant(second.actor("admin", second.workspaceId), f.key);
    expect(
      await db!.appInstallationBot.count({
        where: { installationId: installed.id, state: "granted" },
      }),
    ).toBe(1);

    await f.bots.declare(f.actor("owner"), f.key, false);

    const bots = await db!.appInstallationBot.findMany({
      where: { installation: { app: { key: f.key } } },
      include: { agent: true, credentials: true },
    });
    expect(bots).toHaveLength(2);
    for (const bot of bots) {
      expect(bot.state).toBe("revoked");
      expect(bot.statusText).toBeNull();
      expect(bot.agent.deletedAt).not.toBeNull();
      expect(bot.credentials.every((credential) => credential.revokedAt)).toBe(true);
    }
    expect(await f.bots.authenticate(first.apiKey)).toBeUndefined();
  });
});

describe.skipIf(!db)("declare racing a grant", () => {
  test("turning the declaration off waits for a grant in flight and then revokes what it granted", async () => {
    const f = await granted();
    await f.bots.revoke(f.actor("admin"), f.key);
    let settled = false;
    let declaring: Promise<void> | undefined;
    await db!.$transaction(async (tx) => {
      // A grant in flight: it holds the installation's lock and commits `granted` after the
      // declaration is turned off.
      await tx.$queryRaw`SELECT id FROM app_installations WHERE id = ${f.installationId}::uuid FOR UPDATE`;
      declaring = f.bots.declare(f.actor("owner"), f.key, false).then(() => void (settled = true));
      await Bun.sleep(300);
      expect(settled).toBe(false);
      await tx.appInstallationBot.update({
        where: { installationId: f.installationId },
        data: { state: "granted", revokedAt: null },
      });
    });
    await declaring;
    expect((await f.botRow())!.state).toBe("revoked");
  });
});

describe.skipIf(!db)("grant and revoke (step 2)", () => {
  test("only an owner or admin grants, only for a declared bot on an installed app", async () => {
    const f = await fixture({ enableBot: false });
    expect((await refusal(f.bots.grant(f.actor("admin"), f.key))).errorId).toBe(
      "app-bot-not-declared",
    );
    await f.bots.declare(f.actor("owner"), f.key, true);
    expect((await refusal(f.bots.grant(f.actor("member"), f.key))).code).toBe("ACCESS_DENIED");
    const stranger = await fixture();
    expect((await refusal(stranger.bots.grant(stranger.actor("admin"), f.key))).code).toBe(
      "NOT_FOUND",
    );
  });

  test("granting creates the bot lazily: handle is the app key, name is the app's, no Computer", async () => {
    const f = await fixture();
    const summary = await f.bots.grant(f.actor("admin"), f.key);
    expect(summary).toMatchObject({ installationId: f.installationId, granted: true });
    const row = (await f.botRow())!;
    expect(row).toMatchObject({
      state: "granted",
      generation: 1,
      grantedByUserId: f.people.admin.id,
    });
    expect(row.agent).toMatchObject({
      name: f.key,
      displayName: "Acme Reviews",
      systemKind: "app-bot",
      computerId: null,
      visibility: "public",
      deletedAt: null,
    });
    expect(await db!.agentApiKey.count({ where: { agentId: row.agentId } })).toBe(0);
  });

  test("granting twice changes nothing", async () => {
    const f = await granted();
    const before = (await f.botRow())!;
    await f.bots.grant(f.actor("owner"), f.key);
    const after = (await f.botRow())!;
    expect(after.agentId).toBe(before.agentId);
    expect(after.generation).toBe(1);
  });

  test("a handle held by an ordinary Agent or a member is a conflict, and nothing is renamed", async () => {
    const f = await fixture();
    const holder = await db!.agent.create({
      data: {
        workspaceId: f.workspaceId,
        name: f.key,
        displayName: "Taken",
        ownerId: f.people.owner.id,
        runtimeConfig: {},
      },
    });
    const error = await refusal(f.bots.grant(f.actor("admin"), f.key));
    expect(error.code).toBe("CONFLICT");
    expect(error.errorId).toBe("app-bot-handle-conflict");
    expect((await db!.agent.findUniqueOrThrow({ where: { id: holder.id } })).name).toBe(f.key);
    expect(await f.botRow()).toBeNull();

    const g = await fixture();
    await db!.user.update({ where: { id: g.people.member.id }, data: { username: g.key } });
    expect((await refusal(g.bots.grant(g.actor("admin"), g.key))).errorId).toBe(
      "app-bot-handle-conflict",
    );
  });

  test("revoking disables the bot and ends its key; granting again reactivates the same identity with a new generation", async () => {
    const f = await granted();
    const issued = await (await tokenRequest(f.installationId, f.basic, {})).json();
    const identity = (await f.botRow())!.agentId;
    expect(await f.bots.authenticate(issued.apiKey)).toMatchObject({ agentId: identity });

    await f.bots.revoke(f.actor("admin"), f.key);
    const revoked = (await f.botRow())!;
    expect(revoked).toMatchObject({ state: "revoked", statusText: null });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.agent.deletedAt).not.toBeNull();
    expect(await f.bots.authenticate(issued.apiKey)).toBeUndefined();

    await f.bots.grant(f.actor("admin"), f.key);
    const again = (await f.botRow())!;
    expect(again).toMatchObject({
      agentId: identity,
      state: "granted",
      generation: 2,
      revokedAt: null,
    });
    expect(again.agent.deletedAt).toBeNull();
    // The old key belongs to the old generation and stays dead.
    expect(await f.bots.authenticate(issued.apiKey)).toBeUndefined();
  });

  test("revoking needs an owner or admin, and revoking a bot that is not granted changes nothing", async () => {
    const f = await granted();
    expect((await refusal(f.bots.revoke(f.actor("member"), f.key))).code).toBe("ACCESS_DENIED");
    await f.bots.revoke(f.actor("owner"), f.key);
    await f.bots.revoke(f.actor("owner"), f.key);
    expect((await f.botRow())!.state).toBe("revoked");
  });

  test("a bot Agent deleted through ordinary Agent deletion is reactivated by granting again", async () => {
    const f = await granted();
    const row = (await f.botRow())!;
    await db!.agent.update({ where: { id: row.agentId }, data: { deletedAt: new Date() } });
    await f.bots.grant(f.actor("admin"), f.key);
    const again = (await f.botRow())!;
    expect(again.agent.deletedAt).toBeNull();
    expect(again.generation).toBe(2);
  });

  test("uninstalling archives the bot; installing again and granting reuses the identity", async () => {
    const f = await granted();
    const identity = (await f.botRow())!.agentId;
    const appId = (await db!.app.findUniqueOrThrow({ where: { key: f.key } })).id;
    await db!.$transaction((tx) =>
      removeAppInstallations(tx, {
        appId,
        workspace: f.workspaceId,
        userId: f.people.admin.id,
        at: new Date(),
      }),
    );
    expect(
      (await db!.agent.findUniqueOrThrow({ where: { id: identity } })).deletedAt,
    ).not.toBeNull();
    const installation = await db!.appInstallation.create({
      data: {
        appId: (await db!.app.findUniqueOrThrow({ where: { key: f.key } })).id,
        workspaceId: f.workspaceId,
      },
    });
    await f.bots.grant(f.actor("admin"), f.key);
    const row = await db!.appInstallationBot.findUniqueOrThrow({
      where: { installationId: installation.id },
    });
    expect(row.agentId).toBe(identity);
  });

  test("deleting the app archives its bots", async () => {
    const f = await granted();
    const identity = (await f.botRow())!.agentId;
    await createAppRegistry(db!).deleteApp(f.actor("owner"), f.key);
    expect(
      (await db!.agent.findUniqueOrThrow({ where: { id: identity } })).deletedAt,
    ).not.toBeNull();
    expect(await db!.appInstallationBot.count({ where: { agentId: identity } })).toBe(0);
  });

  test("Settings reads each installed app's bot state", async () => {
    const f = await fixture();
    expect((await f.bots.workspaceBots(f.actor("member"))).get(f.key)).toEqual({
      declared: true,
      installationId: f.installationId,
      granted: false,
      statusText: null,
    });
    await f.bots.grant(f.actor("admin"), f.key);
    expect((await f.bots.workspaceBots(f.actor("member"))).get(f.key)?.granted).toBe(true);
  });
});

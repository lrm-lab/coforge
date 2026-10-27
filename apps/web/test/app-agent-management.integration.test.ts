import { expect, test } from "bun:test";

import { createAppShareLinks } from "#src/server/app-marketplace/app-share-links-composition.server";
import { DAY, db, refusal, registerShareFixture, workspace } from "./share-link-fixture";
import { NOT_FOUND, ORIGIN, PNG, fixture } from "./app-agent-management-fixture";

/**
 * An Agent managing its app beyond registering it (`coforge app update|logo|transfer-owner|delete|
 * share-link|request-publish|...`), against local PostgreSQL with migrations applied: the one
 * authorization (owner Agent or admin-role Agent of the app's Workspace, alive) and each
 * operation's rules.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
registerShareFixture();

test.skipIf(!db)(
  "only the owner Agent or an admin-role Agent of the Workspace manages the app",
  async () => {
    const f = await fixture(db!);
    const elsewhere = await workspace(db!, "Elsewhere");
    try {
      const foreign = await db!.agent.create({
        data: {
          workspaceId: elsewhere.id,
          name: `boss-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "foreign boss",
          ownerId: elsewhere.people.member.id,
          role: "admin",
          runtimeConfig: {},
        },
      });
      const calls = (caller: { workspaceId: string; agentId: string }) => [
        () => f.management.update(caller, f.key, { name: "X" }),
        () => f.management.setLogo(caller, f.key, { contentType: "image/png", dataBase64: PNG }),
        () => f.management.clearLogo(caller, f.key),
        () => f.owners.transferOwner(caller, f.key, "spare"),
        () => f.management.delete(caller, f.key),
        () => f.management.createShareLink(caller, f.key, { expiresDays: 7, origin: ORIGIN }),
        () => f.management.shareLinkStatus(caller, f.key),
        () => f.management.revokeShareLink(caller, f.key),
        () => f.management.requestPublish(caller, f.key),
        () => f.management.requestUnpublish(caller, f.key),
      ];
      // Another Agent of the Workspace, another Workspace's admin Agent: the app is not there.
      for (const caller of [
        f.caller(f.other),
        f.caller(f.spare),
        {
          workspaceId: elsewhere.id,
          agentId: foreign.id,
        },
      ])
        for (const call of calls(caller)) expect(await refusal(call())).toEqual(NOT_FOUND);
      expect((await f.app()).name).toBe("Acme Notes");

      expect((await f.management.update(f.caller(f.scout), f.key, { name: "Owner" })).name).toBe(
        "Owner",
      );
      expect((await f.management.update(f.caller(f.boss), f.key, { name: "Admin" })).name).toBe(
        "Admin",
      );

      // An archived owner Agent has no right, whatever the row says.
      await f.archive(f.scout);
      for (const call of calls(f.caller(f.scout))) expect(await refusal(call())).toEqual(NOT_FOUND);
    } finally {
      await f.cleanup();
      await elsewhere.cleanup();
    }
  },
);

test.skipIf(!db)("update validates with the registry's rules and keeps the rest", async () => {
  const f = await fixture(db!);
  try {
    const caller = f.caller(f.scout);
    const bad = async (changes: Record<string, unknown>) =>
      (await refusal(f.management.update(caller, f.key, changes as never))) as {
        code: string;
        errorId?: string;
      };
    expect(await bad({ name: "" })).toEqual({ code: "INVALID_INPUT", errorId: "app-name-invalid" });
    expect(await bad({ redirectUrls: ["http://evil.example/cb"] })).toEqual({
      code: "INVALID_INPUT",
      errorId: "app-redirect-uris-invalid",
    });
    expect(await bad({ category: "nonsense" })).toMatchObject({ errorId: "app-category-invalid" });
    expect(await bad({ scopes: ["admin"] })).toMatchObject({
      errorId: "app-allowed-scopes-invalid",
    });
    // A redirect URL is never cleared.
    expect(await bad({ redirectUrls: [] })).toEqual({
      code: "INVALID_INPUT",
      errorId: "app-redirect-uris-invalid",
    });

    const updated = await f.management.update(caller, f.key, {
      description: "New text",
      whenToUse: "When notes are needed",
      category: "communication",
      homepageUrl: "https://notes.acme.example/",
      agentManifestUrl: "https://notes.acme.example/agent.json",
      addRedirectUrls: ["https://notes.acme.example/cb2", "https://notes.acme.example/cb"],
      scopes: ["email"],
    });
    expect(updated).toMatchObject({
      clientKey: f.key,
      name: "Acme Notes",
      description: "New text",
      category: "communication",
      homepageUrl: "https://notes.acme.example/",
      redirectUrls: ["https://notes.acme.example/cb", "https://notes.acme.example/cb2"],
      scopes: ["openid", "profile", "identity", "email"],
    });
    const replaced = await f.management.update(caller, f.key, {
      redirectUrls: ["https://notes.acme.example/only"],
      scopes: [],
      homepageUrl: null,
      agentManifestUrl: null,
    });
    expect(replaced).toMatchObject({
      redirectUrls: ["https://notes.acme.example/only"],
      scopes: ["openid", "profile", "identity"],
      homepageUrl: null,
      agentManifestUrl: null,
    });
    // The secret is untouched and never in an answer.
    expect(JSON.stringify(replaced)).not.toContain("cfa_secret");
    expect((await f.app()).secretRotatedAt).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a logo is checked by the registry and removed when cleared", async () => {
  const f = await fixture(db!);
  try {
    const caller = f.caller(f.boss);
    for (const input of [
      { contentType: "image/svg+xml", dataBase64: PNG },
      { contentType: "image/png", dataBase64: Buffer.from("not an image").toString("base64") },
    ])
      expect(await refusal(f.management.setLogo(caller, f.key, input))).toMatchObject({
        code: "INVALID_INPUT",
      });
    const set = await f.management.setLogo(caller, f.key, {
      contentType: "image/png",
      dataBase64: PNG,
    });
    expect(set.hasLogo).toBe(true);
    expect(f.memory.objects.size).toBe(1);
    expect((await f.management.clearLogo(caller, f.key)).hasLogo).toBe(false);
    expect(f.memory.objects.size).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("transfer-owner hands the app to another live public Agent", async () => {
  const f = await fixture(db!);
  try {
    const receipt = await f.owners.transferOwner(f.caller(f.scout), f.key, `@${f.spare.name}`);
    expect(receipt).toMatchObject({
      clientKey: f.key,
      changed: true,
      ownerAgent: f.spare.name,
      previousOwnerAgent: f.scout.name,
    });
    expect((await f.app()).ownerAgentId).toBe(f.spare.id);
    // The former owner is no longer a manager; the new one is.
    expect(await refusal(f.management.delete(f.caller(f.scout), "no-such-app"))).toEqual(NOT_FOUND);
    expect(await refusal(f.management.shareLinkStatus(f.caller(f.scout), f.key))).toEqual(
      NOT_FOUND,
    );
    await f.management.shareLinkStatus(f.caller(f.spare), f.key);

    // To the current owner changes nothing.
    const again = await f.owners.transferOwner(f.caller(f.spare), f.key, f.spare.name);
    expect(again).toMatchObject({ changed: false, ownerAgent: f.spare.name });
    // An admin-role Agent may hand it on, by id too.
    await f.owners.transferOwner(f.caller(f.boss), f.key, f.other.id);
    expect((await f.app()).ownerAgentId).toBe(f.other.id);

    // Not a live public Agent of this Workspace: refused, and nothing moves.
    await f.archive(f.spare);
    await db!.agent.update({ where: { id: f.scout.id }, data: { visibility: "private" } });
    for (const to of ["nobody", f.spare.name, f.scout.name])
      expect(await refusal(f.owners.transferOwner(f.caller(f.boss), f.key, to))).toEqual({
        code: "INVALID_INPUT",
        errorId: "app-owner-agent-invalid",
      });
    expect((await f.app()).ownerAgentId).toBe(f.other.id);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "delete refuses a published or waiting app and removes a private one",
  async () => {
    const f = await fixture(db!);
    try {
      const caller = f.caller(f.scout);
      for (const publishStatus of ["published", "unpublish_requested"]) {
        await db!.app.update({ where: { key: f.key }, data: { publishStatus } });
        expect(await refusal(f.management.delete(caller, f.key))).toEqual({
          code: "CONFLICT",
          errorId: "app-published-undeletable",
        });
        expect(await db!.app.count({ where: { key: f.key } })).toBe(1);
      }
      await db!.app.update({ where: { key: f.key }, data: { publishStatus: "private" } });
      await f.management.setLogo(caller, f.key, { contentType: "image/png", dataBase64: PNG });
      expect(await f.management.delete(caller, f.key)).toEqual({ clientKey: f.key, deleted: true });
      expect(await db!.app.count({ where: { key: f.key } })).toBe(0);
      expect(f.memory.objects.size).toBe(0);
      expect(await refusal(f.management.delete(caller, f.key))).toEqual(NOT_FOUND);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "share links take 1 to 365 days, show the URL once and are Agent-made",
  async () => {
    const f = await fixture(db!);
    try {
      const caller = f.caller(f.boss);
      expect(await f.management.shareLinkStatus(caller, f.key)).toEqual({
        clientKey: f.key,
        active: false,
      });
      for (const expiresDays of [0, 366, 1.5, -1, Number.NaN])
        expect(
          await refusal(
            f.management.createShareLink(caller, f.key, { expiresDays, origin: ORIGIN }),
          ),
        ).toEqual({ code: "INVALID_INPUT", errorId: "app-share-expiry-invalid" });
      expect(await db!.appShareLink.count()).toBe(0);

      for (const days of [1, 365]) {
        const link = await f.management.createShareLink(caller, f.key, {
          expiresDays: days,
          origin: ORIGIN,
        });
        expect(link.url).toStartWith(`${ORIGIN}/apps/share/cfa_share_`);
        expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(days * DAY);
      }
      const status = await f.management.shareLinkStatus(caller, f.key);
      expect(status.active).toBe(true);
      expect(JSON.stringify(status)).not.toContain("cfa_share_");
      const rows = await db!.appShareLink.findMany({ where: { revokedAt: null } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.createdByUserId).toBeNull();

      // The editor path keeps its 30 days.
      const editor = await createAppShareLinks(db!).create(f.ws.actor("owner"), f.key);
      expect(editor.expiresAt.getTime() - editor.createdAt.getTime()).toBe(30 * DAY);

      expect(await f.management.revokeShareLink(caller, f.key)).toEqual({
        clientKey: f.key,
        revoked: true,
      });
      expect((await f.management.shareLinkStatus(caller, f.key)).active).toBe(false);

      // Only a private or rejected app is shared.
      await db!.app.update({ where: { key: f.key }, data: { publishStatus: "published" } });
      expect(
        await refusal(
          f.management.createShareLink(caller, f.key, { expiresDays: 7, origin: ORIGIN }),
        ),
      ).toEqual({ code: "CONFLICT", errorId: "app-share-status-conflict" });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("publish requests need a description and follow the review states", async () => {
  const f = await fixture(db!);
  try {
    const caller = f.caller(f.scout);
    await db!.app.update({ where: { key: f.key }, data: { description: "" } });
    expect(await refusal(f.management.requestPublish(caller, f.key))).toEqual({
      code: "INVALID_INPUT",
      errorId: "app-description-required",
    });
    await f.management.update(caller, f.key, { description: "Notes for the team." });
    expect(await f.management.requestPublish(caller, f.key)).toEqual({
      clientKey: f.key,
      publishStatus: "publish_requested",
    });
    // Repeating answers the state the first reached, with one pending request.
    expect((await f.management.requestPublish(caller, f.key)).publishStatus).toBe(
      "publish_requested",
    );
    const requests = await db!.appReviewRequest.findMany({ where: { app: { key: f.key } } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "publish", requestedByUserId: null, outcome: null });

    // Unpublishing is for a published app.
    expect(await refusal(f.management.requestUnpublish(caller, f.key))).toEqual({
      code: "CONFLICT",
      errorId: "app-publish-status-conflict",
    });
    await db!.appReviewRequest.deleteMany({ where: { app: { key: f.key } } });
    await db!.app.update({ where: { key: f.key }, data: { publishStatus: "published" } });
    expect((await f.management.requestUnpublish(caller, f.key)).publishStatus).toBe(
      "unpublish_requested",
    );
  } finally {
    await f.cleanup();
  }
});

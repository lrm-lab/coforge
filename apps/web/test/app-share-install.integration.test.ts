import { expect, test } from "bun:test";

import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";
import { createAppPublishing } from "#src/server/app-marketplace/app-publishing-composition.server";
import { createAppShareLinks } from "#src/server/app-marketplace/app-share-links-composition.server";
import { DAY, db, refusal, registerShareFixture, scene, workspace } from "./share-link-fixture";

/**
 * Installing from a private share link, against local PostgreSQL with migrations applied: the
 * install and its approval, refusals, the Workspaces the share page offers, and that publication
 * changes revoke neither the link nor an install.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
registerShareFixture();

test.skipIf(!db)("an owner or admin installs from a link and approves what was shown", async () => {
  const s = await scene(db!, "private");
  try {
    const { token } = await createAppShareLinks(db!).create(s.publisher.actor("owner"), s.key);
    const installs = createAppInstallations(db!);
    // Not listed, so not browsable or installable by key.
    expect(
      (await installs.browse(s.buyer.actor("member"))).listings.some((a) => a.key === s.key),
    ).toBe(false);
    expect(await refusal(installs.install(s.buyer.actor("owner"), s.key, 1))).toMatchObject({
      code: "NOT_FOUND",
    });

    expect(await refusal(installs.installShared(s.buyer.actor("member"), token, 1))).toMatchObject({
      code: "ACCESS_DENIED",
    });
    // A declaration that moved on since it was shown installs nothing.
    expect(await refusal(installs.installShared(s.buyer.actor("admin"), token, 0))).toEqual({
      code: "CONFLICT",
      errorId: "app-permissions-changed",
    });
    expect(await s.installation(s.buyer.id)).toBeNull();

    await installs.installShared(s.buyer.actor("admin"), token, 1);
    expect(await s.installation(s.buyer.id)).toMatchObject({
      installedByUserId: s.buyer.people.admin.id,
      agentAccess: "all",
      approvedGroups: ["workspace"],
      approvedRevision: 1,
    });
    // The link is not used up, and installing again changes nothing.
    await installs.installShared(s.buyer.actor("owner"), token, 1);
    const second = await workspace(db!, "Second");
    try {
      await installs.installShared(second.actor("owner"), token, 1);
      expect(await s.installation(second.id)).not.toBeNull();
      expect(await db!.appInstallation.count({ where: { appId: s.appId } })).toBe(3);
    } finally {
      await second.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)(
  "a dead link, the app's own Workspace and a flag that is off are refused",
  async () => {
    const s = await scene(db!, "private");
    const off = await workspace(db!, "Flag off", { flag: "off" });
    try {
      const links = createAppShareLinks(db!);
      const installs = createAppInstallations(db!);
      const { token } = await links.create(s.publisher.actor("owner"), s.key);
      expect(
        await refusal(installs.installShared(s.publisher.actor("owner"), token, 1)),
      ).toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await refusal(installs.installShared(off.actor("owner"), token, 1))).toEqual({
        code: "ACCESS_DENIED",
        errorId: "app-marketplace-off",
      });
      for (const dead of ["", "cfa_share_unknown", token.slice(0, -1)]) {
        expect(
          await refusal(installs.installShared(s.buyer.actor("owner"), dead, 1)),
        ).toMatchObject({
          code: "NOT_FOUND",
        });
        expect(await refusal(installs.previewShared(s.buyer.people.owner.id, dead))).toMatchObject({
          code: "NOT_FOUND",
        });
      }
      // An expired link is dead too.
      await db!.appShareLink.updateMany({
        where: { appId: s.appId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await refusal(installs.installShared(s.buyer.actor("owner"), token, 1))).toMatchObject(
        {
          code: "NOT_FOUND",
        },
      );
      expect(await links.status(s.publisher.actor("owner"), s.key)).toBeNull();
      // A new link replaces the expired one.
      await links.create(s.publisher.actor("owner"), s.key);
      expect(await s.installation(s.buyer.id)).toBeNull();
    } finally {
      await s.cleanup();
      await off.cleanup();
    }
  },
);

test.skipIf(!db)("the share page lists the Workspaces a person may install in", async () => {
  const s = await scene(db!, "private");
  const off = await workspace(db!, "Flag off", { flag: "off" });
  try {
    const { token } = await createAppShareLinks(db!).create(s.publisher.actor("owner"), s.key);
    const installs = createAppInstallations(db!);
    const person = s.buyer.people.admin;
    // The person also owns a Workspace where the flag is off, and is a plain member elsewhere.
    await db!.workspaceMembership.create({
      data: { workspaceId: off.id, userId: person.id, role: "owner" },
    });
    await db!.workspaceMembership.create({
      data: { workspaceId: s.publisher.id, userId: person.id, role: "member" },
    });
    const preview = await installs.previewShared(person.id, token);
    expect(preview.app).toMatchObject({
      key: s.key,
      developer: "Acme Labs",
      permissionRevision: 1,
    });
    expect(preview.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(preview.targets).toEqual([
      {
        workspaceId: s.buyer.id,
        slug: expect.any(String),
        name: "Buyer",
        installed: false,
        approvesOnInstall: true,
      },
    ]);
    await installs.installShared(s.buyer.actor("admin"), token, 1);
    expect((await installs.previewShared(person.id, token)).targets[0]?.installed).toBe(true);
    // The owner of the app sees its own Workspace as already installed.
    const owner = await installs.previewShared(s.publisher.people.owner.id, token);
    expect(owner.targets).toMatchObject([{ name: "Acme Labs", installed: true }]);
  } finally {
    await s.cleanup();
    await off.cleanup();
  }
});

test.skipIf(!db)("publication changes revoke neither the link nor an install", async () => {
  const s = await scene(db!, "private");
  const reviewer = await db!.user.create({
    data: { displayName: "rev", username: `rev-${crypto.randomUUID().slice(0, 8)}` },
  });
  try {
    await db!.platformOperator.create({ data: { userId: reviewer.id, role: "app_reviewer" } });
    await db!.workspaceMembership.create({
      data: { workspaceId: s.publisher.id, userId: reviewer.id, role: "member" },
    });
    const links = createAppShareLinks(db!);
    const installs = createAppInstallations(db!);
    const publishing = createAppPublishing(db!);
    const reviewerActor = { workspaceId: s.publisher.id, actorUserId: reviewer.id };
    const { token } = await links.create(s.publisher.actor("owner"), s.key);
    await installs.installShared(s.buyer.actor("owner"), token, 1);

    // Requesting publication, and a rejection, leave the link and the install alone.
    await publishing.requestPublish(s.publisher.actor("owner"), s.key);
    expect(await links.status(s.publisher.actor("owner"), s.key)).not.toBeNull();
    const request = await db!.appReviewRequest.findFirstOrThrow({
      where: { appId: s.appId, outcome: null },
    });
    await publishing.decide(reviewerActor, request.id, { outcome: "rejected" });
    expect(await links.status(s.publisher.actor("owner"), s.key)).not.toBeNull();
    expect(await s.installation(s.buyer.id)).not.toBeNull();
    const other = await workspace(db!, "Late");
    try {
      // A link keeps installing while the request waits and after the rejection.
      await installs.installShared(other.actor("owner"), token, 1);
      expect(await s.installation(other.id)).not.toBeNull();
    } finally {
      await other.cleanup();
    }

    // Revoking stops new installs and removes none.
    await links.revoke(s.publisher.actor("owner"), s.key);
    expect(await s.installation(s.buyer.id)).not.toBeNull();
    const late = await workspace(db!, "Later");
    try {
      expect(await refusal(installs.installShared(late.actor("owner"), token, 1))).toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await late.cleanup();
    }
  } finally {
    await s.cleanup();
    await db!.user.delete({ where: { id: reviewer.id } }).catch(() => {});
  }
});

test.skipIf(!db)("an approved offline request removes installs made from a link too", async () => {
  const s = await scene(db!, "private");
  const reviewer = await db!.user.create({
    data: { displayName: "rev", username: `rev-${crypto.randomUUID().slice(0, 8)}` },
  });
  try {
    await db!.platformOperator.create({ data: { userId: reviewer.id, role: "app_reviewer" } });
    await db!.workspaceMembership.create({
      data: { workspaceId: s.publisher.id, userId: reviewer.id, role: "member" },
    });
    const { token } = await createAppShareLinks(db!).create(s.publisher.actor("owner"), s.key);
    await createAppInstallations(db!).installShared(s.buyer.actor("owner"), token, 1);
    // Published through review, then taken offline (Raft: "every installed server loses access").
    await db!.app.update({ where: { key: s.key }, data: { publishStatus: "published" } });
    const publishing = createAppPublishing(db!);
    await publishing.requestUnpublish(s.publisher.actor("owner"), s.key);
    const request = await db!.appReviewRequest.findFirstOrThrow({
      where: { appId: s.appId, outcome: null },
    });
    await publishing.decide({ workspaceId: s.publisher.id, actorUserId: reviewer.id }, request.id, {
      outcome: "approved",
    });
    expect(await s.installation(s.buyer.id)).toBeNull();
    expect(await s.installation(s.publisher.id)).not.toBeNull();
    // The link itself stays valid: private sharing is independent of review.
    expect(await createAppShareLinks(db!).status(s.publisher.actor("owner"), s.key)).not.toBeNull();
  } finally {
    await s.cleanup();
    await db!.user.delete({ where: { id: reviewer.id } }).catch(() => {});
  }
});

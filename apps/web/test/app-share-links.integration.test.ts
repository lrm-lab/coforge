import { expect, test } from "bun:test";

import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";
import { hashShareToken } from "#src/server/app-marketplace/app-share-link-token.server";
import { createAppShareLinks } from "#src/server/app-marketplace/app-share-links-composition.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";
import { DAY, db, refusal, registerShareFixture, scene, workspace } from "./share-link-fixture";

/**
 * Private share links, against local PostgreSQL with migrations applied: who manages a link,
 * creating, regenerating and revoking it, that only its hash is stored, which statuses may get one,
 * the flag, and the logo the share page reads through the token.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
registerShareFixture();

test.skipIf(!db)("only owners and admins of the app's Workspace manage its link", async () => {
  const s = await scene(db!, "private");
  const other = await workspace(db!, "Other");
  try {
    const links = createAppShareLinks(db!);
    expect(await refusal(links.create(s.publisher.actor("member"), s.key))).toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(await refusal(links.status(s.publisher.actor("member"), s.key))).toMatchObject({
      code: "ACCESS_DENIED",
    });
    // Another Workspace's app is not confirmed to exist.
    expect(await refusal(links.create(other.actor("owner"), s.key))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await links.status(s.publisher.actor("admin"), s.key)).toBeNull();
    const created = await links.create(s.publisher.actor("admin"), s.key);
    expect(created.token).toStartWith("cfa_share_");
    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(30 * DAY);
    const status = await links.status(s.publisher.actor("owner"), s.key);
    expect(status?.expiresAt).toEqual(created.expiresAt);
    // The status never carries the token.
    expect(JSON.stringify(status)).not.toContain(created.token);
  } finally {
    await s.cleanup();
    await other.cleanup();
  }
});

test.skipIf(!db)("only the token's hash is stored, and one link is active", async () => {
  const s = await scene(db!, "private");
  try {
    const links = createAppShareLinks(db!);
    const first = await links.create(s.publisher.actor("owner"), s.key);
    const rows = await db!.appShareLink.findMany({ where: { appId: s.appId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenHash: hashShareToken(first.token),
      createdByUserId: s.publisher.people.owner.id,
      revokedAt: null,
    });
    expect(JSON.stringify(rows)).not.toContain(first.token);

    // Regenerating revokes the old link: its URL stops working, the new one works.
    const second = await links.create(s.publisher.actor("owner"), s.key);
    expect(second.token).not.toBe(first.token);
    expect(await db!.appShareLink.count({ where: { appId: s.appId, revokedAt: null } })).toBe(1);
    const installs = createAppInstallations(db!);
    expect(await refusal(installs.installShared(s.buyer.actor("owner"), first.token, 1))).toEqual({
      code: "NOT_FOUND",
      errorId: undefined,
    });
    await installs.installShared(s.buyer.actor("owner"), second.token, 1);

    await links.revoke(s.publisher.actor("owner"), s.key);
    await links.revoke(s.publisher.actor("owner"), s.key);
    expect(await links.status(s.publisher.actor("owner"), s.key)).toBeNull();
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)("a link is offered to a private or rejected app only", async () => {
  const s = await scene(db!, "publish_requested");
  try {
    const links = createAppShareLinks(db!);
    expect(await refusal(links.create(s.publisher.actor("owner"), s.key))).toEqual({
      code: "CONFLICT",
      errorId: "app-share-status-conflict",
    });
    await db!.app.update({ where: { key: s.key }, data: { publishStatus: "rejected" } });
    await links.create(s.publisher.actor("owner"), s.key);
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)("the link card is refused where the flag is off", async () => {
  const s = await scene(db!, "private");
  const off = await workspace(db!, "Flag off", { flag: "off" });
  try {
    const denied = { code: "ACCESS_DENIED", errorId: "app-marketplace-off" } as const;
    const links = createAppShareLinks(db!);
    expect(await refusal(links.create(off.actor("owner"), s.key))).toEqual(denied);
    expect(await refusal(links.status(off.actor("owner"), s.key))).toEqual(denied);
    expect(await refusal(links.revoke(off.actor("owner"), s.key))).toEqual(denied);
  } finally {
    await s.cleanup();
    await off.cleanup();
  }
});

test.skipIf(!db)("a share link reads the app's logo through its token only", async () => {
  const s = await scene(db!, "private");
  try {
    await db!.app.update({
      where: { key: s.key },
      data: {
        logoObjectKey: `workspaces/${s.publisher.id}/apps/${s.key}/logos/x/original`,
        logoContentType: "image/png",
      },
    });
    const links = createAppShareLinks(db!);
    const installs = createAppInstallations(db!);
    const { token } = await links.create(s.publisher.actor("owner"), s.key);
    expect(await installs.sharedLogo(token)).toMatchObject({ contentType: "image/png" });
    // The viewer-based read does not widen to someone who only knows the app's key.
    const viewer = s.buyer.people.owner.id;
    expect(
      await new PrismaAppRegistryStore(db!).findLogo({
        workspaceId: s.publisher.id,
        key: s.key,
        viewerUserId: viewer,
      }),
    ).toBeUndefined();
    // A long, unknown or revoked token is the same NOT_FOUND.
    for (const dead of ["x".repeat(500), "cfa_share_unknown"]) {
      expect(await refusal(installs.sharedLogo(dead))).toMatchObject({ code: "NOT_FOUND" });
      expect(await refusal(installs.previewShared(viewer, dead))).toMatchObject({
        code: "NOT_FOUND",
      });
    }
    await links.revoke(s.publisher.actor("owner"), s.key);
    expect(await refusal(installs.sharedLogo(token))).toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await s.cleanup();
  }
});

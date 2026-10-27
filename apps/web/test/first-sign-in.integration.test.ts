import { expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { completeFirstSignIn, readNameStep } from "#src/server/auth/first-sign-in.server";
import { workspaceIdForUser } from "#src/server/workspaces/enrollment.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";

/**
 * First sign-in's name step and the personal Workspace it makes, against local PostgreSQL: the
 * name is saved and titles the Workspace, however many times or from however many tabs it is
 * submitted, exactly one Workspace is made, and the person is its owner in `#general`.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup(options: { fallbackUsername?: boolean; welcomed?: boolean } = {}) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: {
      displayName: `fsi-${suffix}`,
      welcomedAt: options.welcomed ? new Date() : null,
      // The handle a sign-in that told us nothing about the person was given.
      username: options.fallbackUsername ? `user-${suffix}` : `fsi-${suffix}`,
    },
  });
  const memberships = () =>
    db.workspaceMembership.findMany({
      where: { userId: user.id },
      include: { workspace: true },
    });
  const teardown = async () => {
    const owned = await memberships();
    await db.workspace
      .deleteMany({ where: { id: { in: owned.map((row) => row.workspaceId) } } })
      .catch(() => {});
    await db.workspace.deleteMany({ where: { id: { in: seededWorkspaceIds } } }).catch(() => {});
    await db.user
      .deleteMany({ where: { id: { in: [user.id, ...seededUserIds] } } })
      .catch(() => {});
    await db.$disconnect();
  };
  const seededWorkspaceIds: string[] = [];
  const seededUserIds: string[] = [];
  /** A Workspace with its own owner and a join link (optionally already revoked). */
  const inviteLink = async (options: { revoked?: boolean } = {}) => {
    const owner = await db.user.create({
      data: { displayName: `fsi-owner-${suffix}`, username: `fsi-owner-${suffix}` },
    });
    seededUserIds.push(owner.id);
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: `fsi-${suffix}`,
      name: `Invite ${suffix}`,
      userId: owner.id,
    });
    seededWorkspaceIds.push(workspace.id);
    const links = workspaceJoinLinks(db);
    const link = await links.create({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      maxUses: null,
      expiresAt: null,
    });
    if (options.revoked)
      await links.revoke({ workspaceId: workspace.id, actorUserId: owner.id, linkId: link.id });
    return link.token;
  };
  const storedUsername = async () =>
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).username;
  return { db, user, suffix, memberships, teardown, inviteLink, storedUsername };
}

test.skipIf(!connectionString)(
  "submitting a display name saves it and makes an owned Workspace titled with it",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      expect(
        await readNameStep({
          db,
          user: { id: user.id, name: "Provider Ada", username: user.username },
        }),
      ).toEqual({
        status: "ask",
        prefill: "Provider Ada",
        slugPrefill: user.username,
        invite: "none",
      });

      const result = await completeFirstSignIn({
        db,
        user,
        displayName: "  Ada   Lovelace ",
        acceptLanguage: "en-US",
      });

      expect(result.ok).toBe(true);
      const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stored.displayName).toBe("Ada Lovelace");
      const [membership, ...others] = await memberships();
      expect(others).toEqual([]);
      expect(membership?.role).toBe("owner");
      expect(membership?.workspace.name).toBe("Ada Lovelace's Workspace");
      expect(
        await db.conversationMember.count({
          where: { userId: user.id, conversation: { channelName: "general" }, leftAt: null },
        }),
      ).toBe(1);
      expect(
        await readNameStep({ db, user: { id: user.id, name: "", username: user.username } }),
      ).toEqual({
        status: "named",
      });
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a session whose user row is gone is told to sign in again, not asked",
  async () => {
    const { db, user, teardown } = await setup();
    try {
      const gone = crypto.randomUUID();
      expect(await readNameStep({ db, user: { id: gone, name: "Ada", username: "ada" } })).toEqual({
        status: "account_gone",
      });
      expect(
        await readNameStep({ db, user: { id: user.id, name: "Ada", username: "ada-lovelace" } }),
      ).toEqual({ status: "ask", prefill: "Ada", slugPrefill: "ada-lovelace", invite: "none" });
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a name that is not accepted saves nothing and makes no Workspace",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const result = await completeFirstSignIn({
        db,
        user,
        displayName: "System",
        acceptLanguage: "en",
      });

      expect(result).toEqual({ ok: false, problem: "refused" });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).welcomedAt).toBeNull();
      expect(await memberships()).toEqual([]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the same person submitting from several tabs at once ends with one Workspace and the first name",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const results = await Promise.all(
        ["Ada Lovelace", "Ada Lovelace", "Ada King", "Countess Lovelace", "Ada Lovelace"].map(
          (displayName) => completeFirstSignIn({ db, user, displayName, acceptLanguage: "en" }),
        ),
      );

      const workspaceIds = new Set(results.map((result) => (result.ok ? result.workspaceId : "")));
      expect(workspaceIds.size).toBe(1);
      expect(workspaceIds.has("")).toBe(false);
      const rows = await memberships();
      expect(rows).toHaveLength(1);
      // Whichever tab was first, its name is the stored one and it titles the Workspace.
      const stored = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).displayName;
      expect(rows[0]?.workspace.name).toBe(`${stored}'s Workspace`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "two sign-in callbacks enrolling the same new person at once make one Workspace",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const enrolling = { id: user.id, username: user.username, displayName: "Ada Lovelace" };
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => workspaceIdForUser(db, enrolling, "en")),
      );

      expect(new Set(ids).size).toBe(1);
      expect(await memberships()).toHaveLength(1);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "someone who already has a Workspace is named without a second one",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const existing = await workspaceIdForUser(
        db,
        { id: user.id, username: user.username, displayName: "Earlier Name" },
        "en",
      );

      const result = await completeFirstSignIn({
        db,
        user,
        displayName: "Ada Lovelace",
        acceptLanguage: "en",
      });

      expect(result).toEqual({ ok: true, workspaceId: existing });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).displayName).toBe(
        "Ada Lovelace",
      );
      expect(await memberships()).toHaveLength(1);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "signing up through a working invite saves the name and makes no Workspace or membership",
  async () => {
    const { db, user, memberships, teardown, inviteLink } = await setup();
    try {
      const returnTo = `/join/${await inviteLink()}`;
      const person = { id: user.id, name: "Ada", username: user.username };
      expect(await readNameStep({ db, user: person, returnTo })).toMatchObject({
        status: "ask",
        invite: "active",
      });

      const result = await completeFirstSignIn({
        db,
        user,
        displayName: " Ada   Lovelace ",
        returnTo,
        acceptLanguage: "en",
      });

      expect(result).toEqual({ ok: true, workspaceId: null });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).displayName).toBe(
        "Ada Lovelace",
      );
      expect(await memberships()).toEqual([]);
      // A repeated submit keeps the first name.
      await completeFirstSignIn({
        db,
        user,
        displayName: "Ada King",
        returnTo,
        acceptLanguage: "en",
      });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).displayName).toBe(
        "Ada Lovelace",
      );
      expect(await readNameStep({ db, user: person, returnTo })).toEqual({ status: "named" });
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a revoked invite is unavailable: a name-only submit creates nothing, and the normal one makes the Workspace",
  async () => {
    const { db, user, memberships, teardown, inviteLink } = await setup();
    try {
      const returnTo = `/join/${await inviteLink({ revoked: true })}`;
      expect(
        await readNameStep({
          db,
          user: { id: user.id, name: "Ada", username: user.username },
          returnTo,
        }),
      ).toMatchObject({ status: "ask", invite: "unavailable" });

      expect(
        await completeFirstSignIn({
          db,
          user,
          displayName: "Ada Lovelace",
          returnTo,
          acceptLanguage: "en",
        }),
      ).toEqual({ ok: false, problem: "invite_unavailable" });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).welcomedAt).toBeNull();
      expect(await memberships()).toEqual([]);

      const result = await completeFirstSignIn({
        db,
        user,
        displayName: "Ada Lovelace",
        workspaceSlug: `fsi-own-${user.username}`,
        returnTo,
        acceptLanguage: "en",
      });
      expect(result.ok).toBe(true);
      expect(await memberships()).toHaveLength(1);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a returnTo that is not a join path does not skip the Workspace, and an unknown token creates nothing",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      expect(
        await completeFirstSignIn({
          db,
          user,
          displayName: "Ada Lovelace",
          returnTo: "/w/anywhere/join/whatever",
          acceptLanguage: "en",
        }),
      ).toMatchObject({ ok: true });
      expect(await memberships()).toHaveLength(1);

      const second = await setup();
      try {
        expect(
          await completeFirstSignIn({
            db: second.db,
            user: second.user,
            displayName: "Ada Lovelace",
            returnTo: "/join/not-a-token",
            acceptLanguage: "en",
          }),
        ).toEqual({ ok: false, problem: "invite_unavailable" });
        expect(await second.memberships()).toEqual([]);
      } finally {
        await second.teardown();
      }
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "confirming a Chinese name replaces a fallback username with its pinyin, and only once",
  async () => {
    const { db, user, suffix, storedUsername, teardown } = await setup({ fallbackUsername: true });
    try {
      const result = await completeFirstSignIn({
        db,
        user,
        displayName: `张三 ${suffix}`,
        workspaceSlug: `fsi-${suffix}`,
        acceptLanguage: "en",
      });

      expect(result.ok).toBe(true);
      expect(await storedUsername()).toBe(`zhangsan-${suffix}`);

      // A second tab with another name finds the first name standing and the username kept.
      await completeFirstSignIn({
        db,
        user,
        displayName: `李四 ${suffix}`,
        workspaceSlug: `fsi-${suffix}`,
        acceptLanguage: "en",
      });
      expect(await storedUsername()).toBe(`zhangsan-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the new username takes the smallest free -N, and an invite's name-only submit does it too",
  async () => {
    const { db, user, suffix, storedUsername, inviteLink, teardown } = await setup({
      fallbackUsername: true,
    });
    const taken = await db.user.create({
      data: { displayName: "Taken", username: `ada-${suffix}-lovelace` },
    });
    try {
      const token = await inviteLink();
      const result = await completeFirstSignIn({
        db,
        user,
        displayName: `Ada ${suffix} Lovelace`,
        returnTo: `/join/${token}`,
        acceptLanguage: "en",
      });

      expect(result).toEqual({ ok: true, workspaceId: null });
      expect(await storedUsername()).toBe(`ada-${suffix}-lovelace-2`);
    } finally {
      await db.user.delete({ where: { id: taken.id } }).catch(() => {});
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a username that is not a fallback is never changed by confirming a name",
  async () => {
    const { db, user, suffix, storedUsername, teardown } = await setup();
    try {
      await completeFirstSignIn({
        db,
        user,
        displayName: `张三 ${suffix}`,
        workspaceSlug: `fsi-${suffix}`,
        acceptLanguage: "en",
      });

      expect(await storedUsername()).toBe(`fsi-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a name with nothing usable in it leaves the fallback username as it is",
  async () => {
    const { db, user, suffix, storedUsername, teardown } = await setup({ fallbackUsername: true });
    try {
      await completeFirstSignIn({
        db,
        user,
        displayName: "李",
        workspaceSlug: `fsi-${suffix}`,
        acceptLanguage: "en",
      });

      expect(await storedUsername()).toBe(`user-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a personal Workspace made without a chosen URL takes it from the new username",
  async () => {
    const { db, user, suffix, memberships, storedUsername, teardown } = await setup({
      fallbackUsername: true,
    });
    try {
      await completeFirstSignIn({
        db,
        user,
        displayName: `张三 ${suffix}`,
        acceptLanguage: "en",
      });

      expect(await storedUsername()).toBe(`zhangsan-${suffix}`);
      expect((await memberships())[0]?.workspace.slug).toBe(`zhangsan-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "an account that is already named keeps its fallback username when it submits again",
  async () => {
    const { db, user, suffix, storedUsername, teardown } = await setup({
      fallbackUsername: true,
      welcomed: true,
    });
    try {
      await completeFirstSignIn({
        db,
        user,
        displayName: `张三 ${suffix}`,
        workspaceSlug: `fsi-${suffix}`,
        acceptLanguage: "en",
      });

      expect(await storedUsername()).toBe(`user-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a rename that fails is logged without the name and never fails or changes the first sign-in",
  async () => {
    const { db, user, suffix, memberships, storedUsername, teardown } = await setup({
      fallbackUsername: true,
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    // The rename is the only caller of `user.updateMany` on the client itself; transactions use
    // their own client, so the name step's writes go through.
    const failingRename = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "user")
          return new Proxy(value, {
            get: (users, method) =>
              method === "updateMany"
                ? async () => {
                    throw new Error(`boom ${suffix}`);
                  }
                : Reflect.get(users, method, users),
          });
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const result = await completeFirstSignIn({
        db: failingRename,
        user,
        displayName: `张三 ${suffix}`,
        workspaceSlug: `fsi-${suffix}`,
        acceptLanguage: "en",
      });

      expect(result.ok).toBe(true);
      expect(await storedUsername()).toBe(`user-${suffix}`);
      expect(await memberships()).toHaveLength(1);
      const lines = logged.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes("auth.username_rename_failed"))).toBe(true);
      expect(lines.join("\n")).not.toContain(suffix);
      expect(lines.join("\n")).not.toContain("张三");
    } finally {
      logged.mockRestore();
      await teardown();
    }
  },
);

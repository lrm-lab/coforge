import type { PrismaClient } from "#src/generated/prisma/client";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { createAppBots } from "#src/server/app-bots/app-bots-composition.server";

/** A Workspace with an owner, an admin and a member, an app registered by the owner (so installed
 * there, its key `bot-<suffix>`), and a second Workspace where `installElsewhere` can install it. */
export async function botFixture(db: PrismaClient, { enableBot = true } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const person = (role: string) => ({
    displayName: `bot-${role}-${suffix}`,
    username: `bot-${role}-${suffix}`,
  });
  const people = {
    owner: await db.user.create({ data: person("owner") }),
    admin: await db.user.create({ data: person("admin") }),
    member: await db.user.create({ data: person("member") }),
  };
  const workspace = await db.workspace.create({
    data: {
      slug: `bot-${suffix}`,
      name: "Bots",
      members: {
        create: Object.entries(people).map(([role, user]) => ({ userId: user.id, role })),
      },
    },
  });
  const actor = (role: keyof typeof people, workspaceId = workspace.id) => ({
    workspaceId,
    actorUserId: people[role].id,
  });
  const key = `bot-${suffix}`;
  const registration: AppRegistrationInput = {
    key,
    name: "Acme Reviews",
    description: "Reviews things",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "developer-tools",
    allowedScopes: ["openid", "profile", "identity"],
  };
  const { clientSecret } = await createAppRegistry(db).registerApp(actor("owner"), registration);
  const bots = createAppBots(db);
  if (enableBot) await bots.declare(actor("owner"), key, true);
  const installation = await db.appInstallation.findFirstOrThrow({
    where: { workspaceId: workspace.id, app: { key } },
    select: { id: true },
  });
  const basic = `Basic ${Buffer.from(`${key}:${clientSecret}`).toString("base64")}`;
  return {
    key,
    suffix,
    people,
    actor,
    bots,
    clientSecret,
    basic,
    workspaceId: workspace.id,
    installationId: installation.id,
    /** The app's own record of the bot's Agent in this Workspace, whatever its state. */
    async botRow() {
      return db.appInstallationBot.findUnique({
        where: { installationId: installation.id },
        include: { agent: true, credentials: true },
      });
    },
    async cleanup() {
      await db.workspace.deleteMany({ where: { slug: { startsWith: `bot-${suffix}` } } });
      await db.app.deleteMany({ where: { key } });
      await db.user
        .deleteMany({ where: { id: { in: Object.values(people).map((user) => user.id) } } })
        .catch(() => {});
    },
  };
}

export type BotFixture = Awaited<ReturnType<typeof botFixture>>;

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";

export type PageFixture = Awaited<ReturnType<typeof startPageFixture>>;

export async function startPageFixture(label: string) {
  const connectionString = Bun.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const root = await mkdtemp(join(tmpdir(), `${label}-`));
  const blobs = new StoredArtifactBlobs(db, async () => new LocalFileStorage(root));
  const artifacts = new Artifacts(db, blobs);
  const person = async (name: string) =>
    (await db.user.create({ data: { username: `${label}-${name}-${handle}`, displayName: name } }))
      .id;
  const [ownerId, memberId, adminId, outsiderId] = await Promise.all(
    ["owner", "member", "admin", "outsider"].map(person),
  );
  const workspaceId = (
    await db.workspace.create({
      data: {
        slug: `${label}-${handle}`,
        name: label,
        members: {
          create: [
            { userId: ownerId!, role: "member" },
            { userId: memberId!, role: "member" },
            { userId: adminId!, role: "admin" },
          ],
        },
      },
    })
  ).id;
  const agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `${label}-writer-${handle}`,
        displayName: "Writer",
        ownerId: ownerId!,
        runtimeConfig: {},
      },
    })
  ).id;
  const homeId = (
    await db.conversation.create({
      data: { workspaceId, channelName: `${label}-home-${handle}`, visibility: "private" },
    })
  ).id;
  await db.conversationMember.create({ data: { conversationId: homeId, workspaceId, agentId } });
  const page = async (name: string, access: "workspace" | "conversation" = "workspace") => {
    const created = await artifacts.create({
      workspaceId,
      home: { kind: "conversation", conversationId: homeId },
      name: `${name}-${handle}`,
      entryPath: "index.html",
      author: { agentId },
    });
    const html = new TextEncoder().encode("<p>page</p>") as Uint8Array<ArrayBuffer>;
    const { sha256 } = await blobs.upload({ workspaceId, bytes: html, actor: { agentId } });
    await artifacts.push({
      workspaceId,
      artifactId: created.id,
      baseVersion: 0,
      publisher: { agentId },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "index.html", sha256 }],
    });
    if (access === "workspace")
      await db.artifact.update({ where: { id: created.id }, data: { access: "workspace" } });
    return created.id;
  };
  return {
    db,
    blobs,
    artifacts,
    workspaceId,
    ownerId: ownerId!,
    memberId: memberId!,
    adminId: adminId!,
    outsiderId: outsiderId!,
    page,
    as: (userId: string, artifactId: string) => ({ workspaceId, artifactId, userId }),
    async stop() {
      await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await db.user.deleteMany({
        where: { id: { in: [ownerId!, memberId!, adminId!, outsiderId!] } },
      });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}

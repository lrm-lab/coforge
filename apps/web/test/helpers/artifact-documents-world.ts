import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";

export async function artifactDocumentsWorld(db: PrismaClient, handle: string) {
  const root = await mkdtemp(join(tmpdir(), "artifact-documents-"));
  const storage = new LocalFileStorage(root);
  const blobs = new StoredArtifactBlobs(db, async () => storage);
  const artifacts = new Artifacts(db, blobs);
  const documents = new ArtifactDocuments(db, artifacts, blobs);
  const alice = (
    await db.user.create({ data: { username: `ad-a-${handle}`, displayName: "Alice" } })
  ).id;
  const bob = (await db.user.create({ data: { username: `ad-b-${handle}`, displayName: "Bob" } }))
    .id;
  const workspaceId = (
    await db.workspace.create({
      data: {
        slug: `ad-${handle}`,
        name: "Docs",
        members: {
          create: [
            { userId: alice, role: "owner" },
            { userId: bob, role: "member" },
          ],
        },
      },
    })
  ).id;
  const newAgent = async (name: string) =>
    (
      await db.agent.create({
        data: {
          workspaceId,
          name: `ad-${name}-${handle}`,
          displayName: name,
          ownerId: alice,
          runtimeConfig: {},
        },
      })
    ).id;
  const writer = await newAgent("writer");
  const helper = await newAgent("helper");
  const channel = async (
    name: string,
    visibility: string,
    members: ({ userId: string } | { agentId: string })[],
  ) => {
    const { id } = await db.conversation.create({
      data: { workspaceId, channelName: `${name}-${handle}`, visibility },
    });
    await db.conversationMember.createMany({
      data: members.map((member) => ({ conversationId: id, workspaceId, ...member })),
    });
    return id;
  };
  const channelId = await channel("launch", "public", [
    { userId: alice },
    { userId: bob },
    { agentId: writer },
    { agentId: helper },
  ]);
  const secretId = await channel("secret", "private", [{ userId: alice }, { agentId: writer }]);
  return {
    root,
    blobs,
    artifacts,
    documents,
    workspaceId,
    alice,
    bob,
    writer,
    helper,
    channelId,
    secretId,
    async cleanup() {
      await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: { in: [alice, bob] } } });
      await rm(root, { recursive: true, force: true });
    },
    async manifest(agentId: string, files: Record<string, string>, entryPath?: string) {
      const named = await Promise.all(
        Object.entries(files).map(async ([path, text]) => ({
          path,
          sha256: (
            await blobs.upload({
              workspaceId,
              bytes: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>,
              actor: { agentId },
            })
          ).sha256,
        })),
      );
      return { files: named, ...(entryPath ? { entryPath } : {}) };
    },
  };
}

export type ArtifactDocumentsWorld = Awaited<ReturnType<typeof artifactDocumentsWorld>>;

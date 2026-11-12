import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

/**
 * A Workspace for the artifact comment suites: Alice (owner) and Bob (member), three Agents in a
 * public channel, a private channel only Alice and the Writer Bot are in, and `post`, one Agent's
 * request on `POST /api/agent/v1/artifacts`.
 */
export type CommentsFixture = Awaited<ReturnType<typeof commentsFixture>>;

export async function commentsFixture(prefix: string) {
  const connectionString = Bun.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const storage = new LocalFileStorage(root);
  const blobs = new StoredArtifactBlobs(db, async () => storage);
  const artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  const documents = new ArtifactDocuments(db, artifacts, blobs);

  const alice = (
    await db.user.create({ data: { username: `${prefix}-a-${handle}`, displayName: "Alice" } })
  ).id;
  const bob = (
    await db.user.create({ data: { username: `${prefix}-b-${handle}`, displayName: "Bob" } })
  ).id;
  const workspaceId = (
    await db.workspace.create({
      data: {
        slug: `${prefix}-${handle}`,
        name: "Comments",
        members: {
          create: [
            { userId: alice, role: "owner" },
            { userId: bob, role: "member" },
          ],
        },
      },
    })
  ).id;
  const agents = { writer: "", reader: "", other: "" };
  for (const [key, displayName] of [
    ["writer", "Writer Bot"],
    ["reader", "Reader Bot"],
    ["other", "Other Bot"],
  ] as const) {
    agents[key] = (
      await db.agent.create({
        data: {
          workspaceId,
          name: `${prefix}-${key}-${handle}`,
          displayName,
          ownerId: alice,
          runtimeConfig: {},
        },
      })
    ).id;
  }
  const channel = async (
    data: { channelName: string; visibility: string },
    members: ({ userId: string } | { agentId: string })[],
  ) => {
    const { id } = await db.conversation.create({ data: { workspaceId, ...data } });
    await db.conversationMember.createMany({
      data: members.map((member) => ({ conversationId: id, workspaceId, ...member })),
    });
    return id;
  };
  const docsChannel = `docs-${handle}`;
  await channel({ channelName: docsChannel, visibility: "public" }, [
    { userId: alice },
    { userId: bob },
    { agentId: agents.writer },
    { agentId: agents.reader },
    { agentId: agents.other },
  ]);
  const privateChannel = `private-${handle}`;
  await channel({ channelName: privateChannel, visibility: "private" }, [
    { userId: alice },
    { agentId: agents.writer },
  ]);

  async function post(agentId: string, body: unknown) {
    const response = await handleAgentArtifactPost(
      new Request("http://local/api/agent/v1/artifacts", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { workspaceId, agentId },
      { db, artifacts, documents, enabled: async () => true },
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  /** Uploads each file's bytes for the Agent, and names them as a manifest. */
  async function manifestOf(agentId: string, files: Record<string, string>) {
    const named: { path: string; sha256: string }[] = [];
    for (const [path, content] of Object.entries(files)) {
      const bytes = new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>;
      await blobs.upload({ workspaceId, bytes, actor: { agentId } });
      named.push({ path, sha256: sha256(bytes) });
    }
    return named;
  }

  const key = () => crypto.randomUUID();

  /** An artifact of the given files, entry `plan.md`, made by the Writer Bot in the public
   * channel (version 1). */
  async function make(
    title: string,
    files: Record<string, string> = { "plan.md": "one\ntwo\nthree\n" },
    options: { target?: string; by?: string } = {},
  ) {
    const by = options.by ?? agents.writer;
    const created = await post(by, {
      operation: "create",
      title,
      target: options.target ?? `#${docsChannel}`,
      files: await manifestOf(by, files),
      entry: "plan.md",
    });
    if (created.status !== 200) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
    return created.body.id as string;
  }

  /** A person's comment, written straight into the table (the Agent API writes an Agent's). */
  async function personComments(
    artifactId: string,
    userId: string,
    input: { body: string; path?: string | null; version?: number; replyToRoot?: string },
  ) {
    const artifact = await db.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    const last = await db.artifactComment.findFirst({
      where: { artifactId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    });
    const createdAt = new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1));
    return db.artifactComment.create({
      data: {
        artifactId,
        version: input.version ?? artifact.currentVersion,
        path: input.path ?? null,
        rootId: input.replyToRoot ?? null,
        authorUserId: userId,
        body: input.body,
        createdAt,
      },
    });
  }

  /** A push of one text over the newest version, by an Agent. */
  async function pushText(artifactId: string, agentId: string, text: string) {
    const current = (await db.artifact.findUniqueOrThrow({ where: { id: artifactId } }))
      .currentVersion;
    return post(agentId, {
      operation: "push",
      artifact: artifactId,
      baseVersion: current,
      idempotencyKey: key(),
      text,
    });
  }

  /** A push of some files over the newest version, by an Agent. */
  async function pushFiles(
    artifactId: string,
    agentId: string,
    files: Record<string, string>,
    extra: { delete?: string[] } = {},
  ) {
    const current = (await db.artifact.findUniqueOrThrow({ where: { id: artifactId } }))
      .currentVersion;
    return post(agentId, {
      operation: "push",
      artifact: artifactId,
      baseVersion: current,
      idempotencyKey: key(),
      files: await manifestOf(agentId, files),
      ...extra,
    });
  }

  /** Resolves once a request is waiting on an advisory lock: the observable that a write is
   * blocked on the comment lock, not merely slow. */
  async function waitForLockWaiter() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted`;
      if (row!.waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no request is waiting on an advisory lock");
  }

  async function cleanup() {
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }

  return {
    db,
    workspaceId,
    alice,
    bob,
    agents,
    docsChannel,
    privateChannel,
    post,
    key,
    make,
    personComments,
    pushText,
    pushFiles,
    waitForLockWaiter,
    cleanup,
  };
}

import sharp from "sharp";
import { ArtifactCommentDrafts } from "#src/server/artifacts/artifact-comment-drafts.server";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import type { ArtifactSignalEvent } from "#src/server/artifacts/artifact-signals.server";
import { commentsFixture } from "./artifact-comments-fixture";

export const lines = { type: "lines", data: { start: 1, end: 2 } } as const;

export async function draftsHarness(prefix: string) {
  const f = await commentsFixture(prefix);
  const events: ArtifactSignalEvent[] = [];
  const signals = {
    publish: async (_channel: string, event: ArtifactSignalEvent) => {
      events.push(event);
    },
  };
  const drafts = new ArtifactCommentDrafts(f.db, f.blobs, async () => true, f.notices, signals);
  const comments = new ArtifactPersonComments(f.db, f.blobs, async () => true, f.notices, signals);

  const place = (artifactId: string, userId = f.alice) => ({
    workspaceId: f.workspaceId,
    artifactId,
    userId,
  });
  const create = (artifactId: string, body: string, extra: object = {}, userId = f.alice) =>
    drafts.create({
      ...place(artifactId, userId),
      draft: { version: 1, body, path: "plan.md", anchor: lines, ...extra },
    } as Parameters<ArtifactCommentDrafts["create"]>[0]);
  const idsOf = async (artifactId: string, userId = f.alice) =>
    (await drafts.list(place(artifactId, userId))).drafts.map((draft) => draft.id);
  const submit = async (artifactId: string, userId = f.alice, clientKey = f.key()) =>
    drafts.submit({
      ...place(artifactId, userId),
      draftIds: await idsOf(artifactId, userId),
      clientKey,
    });
  const png = (shade: number) =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: 0, b: 0 } } })
      .png()
      .toBuffer()
      .then((buffer) => new Uint8Array(buffer) as Uint8Array<ArrayBuffer>);
  const upload = async (artifactId: string, shade: number) =>
    (await comments.uploadImage({ ...place(artifactId), bytes: await png(shade) })).sha256;
  const blobOf = (sha256: string) =>
    f.db.artifactBlob.findUniqueOrThrow({
      where: { workspaceId_sha256: { workspaceId: f.workspaceId, sha256 } },
    });
  const nameOf = async (agentId: string) =>
    (await f.db.agent.findUniqueOrThrow({ where: { id: agentId } })).name;

  async function waitForBlockedStatement(queryLike: string, count = 1) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [row] = await f.db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()
          AND pid <> pg_backend_pid() AND query ILIKE ${queryLike}`;
      if (row!.waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no statement like ${queryLike} is waiting on a lock`);
  }

  return {
    f,
    drafts,
    comments,
    events,
    place,
    create,
    idsOf,
    submit,
    upload,
    blobOf,
    nameOf,
    waitForBlockedStatement,
  };
}

export type DraftsHarness = Awaited<ReturnType<typeof draftsHarness>>;

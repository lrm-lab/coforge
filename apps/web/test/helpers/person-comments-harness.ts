import sharp from "sharp";
import { commentDraftInput } from "#src/features/artifacts/artifact-comment-inputs";
import type { ArtifactSignalEvent } from "#src/server/artifacts/artifact-signals.server";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import { commentsFixture, type CommentsFixture } from "./artifact-comments-fixture";

export function personCommentsHarness(
  prefix: string,
  onReady: (ready: { f: CommentsFixture; comments: ArtifactPersonComments }) => void,
) {
  let f: CommentsFixture;
  let comments: ArtifactPersonComments;
  const events: ArtifactSignalEvent[] = [];
  const place = (artifactId: string, userId = f.alice) => ({
    workspaceId: f.workspaceId,
    artifactId,
    userId,
  });
  const draft = (body: string, extra: object = {}) =>
    commentDraftInput.parse({ body, idempotencyKey: f.key(), ...extra });
  const post = (artifactId: string, body: string, extra: object = {}, userId = f.alice) =>
    comments.post({ ...place(artifactId, userId), comment: draft(body, extra) });
  const list = (artifactId: string, userId = f.alice, before?: string) =>
    comments.list({ ...place(artifactId, userId), before });
  return {
    events,
    place,
    draft,
    post,
    list,
    bodiesOf: (page: Awaited<ReturnType<typeof list>>) =>
      page.comments.map((comment) => ("deleted" in comment ? "(deleted)" : comment.body)),
    noticesAbout: async (agentId: string, artifactId: string) =>
      (await f.noticesOf(agentId)).filter((notice) =>
        notice.externalEventId.startsWith(artifactId),
      ),
    namesOf: async (...agentIds: string[]) =>
      (await f.db.agent.findMany({ where: { id: { in: agentIds } }, select: { name: true } })).map(
        (agent) => agent.name,
      ),
    pngOf: (shade: number) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: 0, b: 0 } } })
        .png()
        .toBuffer()
        .then((buffer) => new Uint8Array(buffer) as Uint8Array<ArrayBuffer>),
    setUp: async () => {
      f = await commentsFixture(prefix);
      comments = new ArtifactPersonComments(f.db, f.blobs, f.notices, {
        publish: async (_channel, event) => {
          events.push(event);
        },
      });
      onReady({ f, comments });
    },
    tearDown: () => f.cleanup(),
  };
}

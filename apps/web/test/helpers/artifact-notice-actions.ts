import type { CommentsFixture } from "./artifact-comments-fixture";

export function noticeActions(fixture: () => CommentsFixture) {
  return {
    comment: (agentId: string, artifact: string, body: string, extra: object = {}) =>
      fixture().post(agentId, {
        operation: "comment",
        artifact,
        body,
        idempotencyKey: fixture().key(),
        ...extra,
      }),
    catchUp: (agentId: string, artifact: string) =>
      fixture().post(agentId, { operation: "comments", artifact }),
    follow: (agentId: string, artifact: string) =>
      fixture().post(agentId, { operation: "follow", artifact }),
    unfollow: (agentId: string, artifact: string) =>
      fixture().post(agentId, { operation: "unfollow", artifact }),
    told: async (agentId: string, artifact: string) =>
      (await fixture().noticesOf(agentId)).filter((notice) =>
        notice.externalEventId.startsWith(`${artifact}:`),
      ),
  };
}

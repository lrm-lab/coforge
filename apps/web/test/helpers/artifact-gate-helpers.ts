import { expect } from "bun:test";
import type { CommentsFixture } from "./artifact-comments-fixture";

/** The requests and the refusal check the unseen-gate suites share. */
export function gateHelpers(fixture: () => CommentsFixture) {
  const FILES = { "plan.md": "one\ntwo\n", "data.csv": "x\n1\n" };
  const comment = (agentId: string, artifact: string, body: string, extra: object = {}) =>
    fixture().post(agentId, {
      operation: "comment",
      artifact,
      body,
      idempotencyKey: fixture().key(),
      ...extra,
    });
  const read = (agentId: string, artifact: string, extra: object = {}) =>
    fixture().post(agentId, { operation: "comments", artifact, ...extra });

  function shownIn(answer: { body: Record<string, any> }) {
    return JSON.parse(answer.body.details.unseen as string) as {
      comments: { id: string; body: string }[];
      excerpts: { id: string }[];
      versions: { number: number }[];
    };
  }

  function expectGate(
    answer: { status: number; body: Record<string, any> },
    count: number,
    ids: string[],
  ) {
    expect(answer.status).toBe(409);
    expect(answer.body.error).toContain("(artifact-unseen-changes)");
    expect(answer.body.code).toBe("CONFLICT");
    expect(answer.body.details.commentCount).toBe(count);
    const shown = shownIn(answer);
    expect([...shown.comments, ...shown.excerpts].map((entry) => entry.id)).toEqual(ids);
  }

  return { FILES, comment, read, shownIn, expectGate };
}

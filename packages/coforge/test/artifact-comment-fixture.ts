import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { parseArgs } from "../index";
import type { ArtifactInvocation } from "../src/artifact-commands";

/** Shared by the artifact comment command tests: ids, a transport that answers one thing, and a
 * comment as the server answers it. */

export const ID = "0f8c3b52-6d0e-4f3a-9a51-3c1d2e4f5a6b";
export const C1 = "01a1ce83-d0cd-711f-8770-8485de9b737f";
export const C2 = "01a1ce83-d0cd-7f10-9f51-6a1b2c3d4e5f";
export const C3 = "01a1ce84-0000-7aaa-8bbb-111122223333";
export const REVIEW = "01a1ce85-1111-7222-8333-444455556666";

export const invocation = (args: string[]) =>
  parseArgs(["artifact", ...args]) as ArtifactInvocation;
export function transportAnswering(answer: unknown) {
  const sent: AgentArtifactRequest[] = [];
  return {
    sent,
    transport: {
      artifact: async (request: AgentArtifactRequest) => {
        sent.push(request);
        return answer;
      },
    },
  };
}

export const comment = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  author: { kind: "user", name: "Alice" },
  version: 2,
  path: "plan.md",
  anchor: { type: "lines", data: { start: 3, end: 4 } },
  replyTo: null,
  body: "Why three lines?",
  createdAt: "2026-11-12T09:30:00.000Z",
  editedAt: null,
  reviewId: null,
  resolvedAt: null,
  resolvedBy: null,
  ...extra,
});

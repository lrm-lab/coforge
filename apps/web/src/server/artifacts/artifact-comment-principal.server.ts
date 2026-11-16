import type { PrismaClient } from "#src/generated/prisma/client";
import type { ArtifactActor } from "./artifact-access.server";
import {
  recordingRefusal,
  requireNoUnseenChanges,
  type GatedWrite,
  type WriteScope,
} from "./artifact-comment-gate.server";
import type { CommentTx } from "./artifact-comment-write.server";

export type CommentPrincipal = { workspaceId: string } & (
  | { kind: "person"; userId: string }
  | { kind: "agent"; agentId: string }
);

export const agentPrincipal = (input: {
  workspaceId: string;
  agentId: string;
}): CommentPrincipal => ({
  kind: "agent",
  ...input,
});

export const personPrincipal = (input: {
  workspaceId: string;
  userId: string;
}): CommentPrincipal => ({
  kind: "person",
  ...input,
});

export const actorOf = (principal: CommentPrincipal): ArtifactActor =>
  principal.kind === "agent" ? { agentId: principal.agentId } : { userId: principal.userId };

export type UnseenGate = {
  recording<T>(
    db: Pick<PrismaClient, "$executeRaw">,
    artifactId: string,
    work: () => Promise<T>,
  ): Promise<T>;
  require(
    tx: CommentTx,
    input: {
      artifactId: string;
      action: GatedWrite;
      scopes: readonly WriteScope[];
      indexed?: boolean;
    },
  ): Promise<void>;
};

const personGate: UnseenGate = {
  recording: (_db, _artifactId, work) => work(),
  require: async () => undefined,
};

export function unseenGate(principal: CommentPrincipal): UnseenGate {
  if (principal.kind === "person") return personGate;
  const { workspaceId, agentId } = principal;
  return {
    recording: (db, artifactId, work) => recordingRefusal(db, { artifactId, agentId }, work),
    require: (tx, input) => requireNoUnseenChanges(tx, { workspaceId, agentId, ...input }),
  };
}

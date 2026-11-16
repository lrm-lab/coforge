import { createHash } from "node:crypto";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  ARTIFACT_SHARE_MAX_TARGETS,
  ARTIFACT_SHARE_NOTE_MAX_LENGTH,
} from "#src/features/artifacts/artifact-share-input";
import { AppError, isAppError } from "#src/lib/app-error";
import { membersWithoutOtherConversationRead } from "#src/server/conversations/channel-read-access.server";
import {
  artifactHomeConversationId,
  artifactTier,
  artifactsDisabled,
  requireArtifactRead,
} from "./artifact-access.server";

export type ArtifactShareFailureCode = "no_access" | "archived" | "read_only" | "failed";
export type ArtifactShareDestinationResult =
  | {
      target: string;
      status: "success";
      message: { id: string; sequence: number };
    }
  | {
      target: string;
      status: "failed";
      error: { code: ArtifactShareFailureCode };
    };

export type ArtifactShareHold = { target: string; people: number; agents: number };

export type ArtifactShareResult =
  | {
      outcome: "success" | "partial_failure" | "all_failed" | "idempotent_replay";
      results: ArtifactShareDestinationResult[];
    }
  | { outcome: "held"; results: []; held: ArtifactShareHold[] };

export function artifactShareIdempotencyKey(requestId: string, target: string): string {
  const bytes = createHash("sha256").update(`artifact-share:${requestId}:${target}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type ArtifactShareSender = (input: {
  target: string;
  idempotencyKey: string;
  body: string;
}) => Promise<{ id: string; sequence: number }>;

export class ArtifactShares {
  constructor(
    private readonly db: Pick<
      PrismaClient,
      | "artifact"
      | "artifactPublicLink"
      | "workspace"
      | "workspaceMembership"
      | "agent"
      | "conversation"
    >,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
  ) {}

  async share(input: {
    workspaceId: string;
    actor: { userId: string };
    artifactId: string;
    targets: readonly string[];
    note?: string;
    requestId: string;
    unseen?: "hold" | "send";
    send: ArtifactShareSender;
  }): Promise<ArtifactShareResult> {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const targets = [...new Set(input.targets)];
    if (!targets.length || !input.requestId.trim())
      throw new AppError("INVALID_INPUT", {
        errorId: "artifact-share-request",
      });
    if ((input.note?.length ?? 0) > ARTIFACT_SHARE_NOTE_MAX_LENGTH)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-share-note" });
    if (targets.length > ARTIFACT_SHARE_MAX_TARGETS)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-share-request" });

    const artifactId = input.artifactId.toLowerCase();
    const [workspace, row] = await Promise.all([
      this.db.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { slug: true },
      }),
      this.db.artifact.findFirst({
        where: {
          workspaceId: input.workspaceId,
          id: artifactId,
          deletedAt: null,
        },
        select: { id: true, homeKey: true, access: true, authorAgentId: true },
      }),
    ]);
    if (!workspace || !row) throw new AppError("NOT_FOUND");
    await requireArtifactRead(this.db, input.workspaceId, input.actor, row);
    if (input.unseen !== "send") {
      const held = await this.recipientsWhoCannotSee(input.workspaceId, row, targets);
      if (held.length > 0) return { outcome: "held", results: [], held };
    }

    const body = [input.note?.trim(), `/w/${workspace.slug}/artifacts/${artifactId}`]
      .filter(Boolean)
      .join("\n\n");
    const results: ArtifactShareDestinationResult[] = [];
    for (const target of targets) {
      try {
        const message = await input.send({
          target,
          idempotencyKey: artifactShareIdempotencyKey(input.requestId, target),
          body,
        });
        results.push({
          target,
          status: "success",
          message: { id: message.id, sequence: message.sequence },
        });
      } catch (error) {
        results.push({
          target,
          status: "failed",
          error: { code: shareFailureOf(error) },
        });
      }
    }
    const succeeded = results.filter((result) => result.status === "success").length;
    return {
      outcome:
        succeeded === 0 ? "all_failed" : succeeded < results.length ? "partial_failure" : "success",
      results,
    };
  }

  private async recipientsWhoCannotSee(
    workspaceId: string,
    artifact: { id: string; homeKey: string; access: string },
    targets: readonly string[],
  ): Promise<ArtifactShareHold[]> {
    const home = artifactHomeConversationId(artifact.homeKey);
    if (artifactTier(artifact) === "workspace" || !home) return [];
    const link = await this.db.artifactPublicLink.findFirst({
      where: { artifactId: artifact.id, revokedAt: null },
      select: { id: true },
    });
    if (link) return [];
    const counts = await Promise.all(
      targets.map(async (target) => ({
        target,
        ...(await membersWithoutOtherConversationRead(this.db, workspaceId, target, home)),
      })),
    );
    return counts.flatMap(({ target, people, agents }) =>
      people === undefined || agents === undefined || people + agents === 0
        ? []
        : [{ target, people, agents }],
    );
  }
}

function shareFailureOf(error: unknown): ArtifactShareFailureCode {
  if (!isAppError(error)) return "failed";
  switch (error.code) {
    case "CONFLICT":
      return "archived";
    case "ACCESS_DENIED":
    case "NOT_FOUND":
    case "AGENT_DM_RESTRICTED":
    case "DM_PEER_NOT_IN_WORKSPACE":
    case "TARGET_NOT_ACCESSIBLE":
      return "no_access";
    default:
      return "failed";
  }
}

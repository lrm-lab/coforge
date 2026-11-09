import { createHash } from "node:crypto";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import {
  type ArtifactActor,
  artifactReadAccess,
  artifactsDisabled,
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

export type ArtifactShareResult = {
  outcome: "success" | "partial_failure" | "all_failed" | "idempotent_replay";
  results: ArtifactShareDestinationResult[];
};

/** One destination key, stable across retries and independent of the number of artifacts shared. */
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

export type ArtifactShareTargetResolution = { kind: "agent"; agentId: string } | { kind: "other" };

export type ArtifactShareTargetResolver = (
  workspaceId: string,
  agentId: string,
  target: string,
) => Promise<ArtifactShareTargetResolution>;

const MAX_SHARE_ARTIFACTS = 20;
const MAX_SHARE_TARGETS = 20;

/**
 * Shares live artifact links by posting ordinary messages. The artifact rows are checked once
 * before any destination is attempted; every destination then uses the caller's normal message
 * authorization and its own derived idempotency key.
 */
export class ArtifactShares {
  constructor(
    private readonly db: Pick<
      PrismaClient,
      "artifact" | "workspace" | "workspaceMembership" | "agent" | "conversation"
    >,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
    private readonly resolveTarget?: ArtifactShareTargetResolver,
  ) {}

  async share(input: {
    workspaceId: string;
    actor: ArtifactActor;
    artifactIds: readonly string[];
    targets: readonly string[];
    note?: string;
    requestId: string;
    send: ArtifactShareSender;
  }): Promise<ArtifactShareResult> {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    if (input.artifactIds.length > MAX_SHARE_ARTIFACTS || input.targets.length > MAX_SHARE_TARGETS)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-share-request" });
    const artifactIds = [...new Set(input.artifactIds)];
    const targets = [...new Set(input.targets)];
    if (!artifactIds.length || !targets.length || !input.requestId.trim())
      throw new AppError("INVALID_INPUT", {
        errorId: "artifact-share-request",
      });
    if ((input.note?.length ?? 0) > 500)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-share-note" });

    const [workspace, rows] = await Promise.all([
      this.db.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { slug: true },
      }),
      this.db.artifact.findMany({
        where: {
          workspaceId: input.workspaceId,
          id: { in: artifactIds },
          deletedAt: null,
        },
        select: { id: true, title: true, homeKey: true, access: true },
      }),
    ]);
    if (!workspace) throw new AppError("NOT_FOUND");
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (rows.length !== artifactIds.length) throw new AppError("NOT_FOUND");
    for (const artifactId of artifactIds) {
      const artifact = byId.get(artifactId);
      if (!artifact) throw new AppError("NOT_FOUND");
      if (!(await artifactReadAccess(this.db, input.workspaceId, input.actor, artifact)))
        throw new AppError("NOT_FOUND");
    }

    const links = artifactIds.map((id) => `/w/${workspace.slug}/artifacts/${id}`);
    const body = [input.note?.trim(), links.join("\n")].filter(Boolean).join("\n\n");
    const results: ArtifactShareDestinationResult[] = [];
    for (const target of targets) {
      try {
        const message = await input.send({
          target,
          idempotencyKey: artifactShareIdempotencyKey(input.requestId, target),
          body: await this.bodyForTarget(
            target,
            body,
            input.note,
            links,
            rows,
            input.workspaceId,
            input.actor,
          ),
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

  private async bodyForTarget(
    target: string,
    fallback: string,
    note: string | undefined,
    links: readonly string[],
    rows: readonly { id: string; title: string; homeKey: string; access: string }[],
    workspaceId: string,
    actor: ArtifactActor,
  ) {
    if (!actor.agentId || !this.resolveTarget) return fallback;
    let resolved: ArtifactShareTargetResolution;
    try {
      resolved = await this.resolveTarget(workspaceId, actor.agentId, target);
    } catch {
      return fallback;
    }
    if (resolved.kind !== "agent") return fallback;
    const readable = await Promise.all(
      rows.map((row) =>
        artifactReadAccess(this.db, workspaceId, { agentId: resolved.agentId }, row),
      ),
    );
    if (!readable.every(Boolean))
      return [note?.trim(), `One artifact was shared:\n${links.join("\n")}`]
        .filter(Boolean)
        .join("\n\n");
    return [
      note?.trim(),
      rows.map((row, index) => `${row.title || "Untitled artifact"}\n${links[index]}`).join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n\n");
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

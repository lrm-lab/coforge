import { z } from "zod";
import { ARTIFACT_SHA256_PATTERN, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { commentInputs } from "#src/features/artifacts/artifact-comment-inputs";
import { artifactInputs } from "#src/features/artifacts/artifact-inputs";
import { AppError } from "#src/lib/app-error";
import { errorType } from "#src/server/errors/error-type.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { artifactsDisabled, type ArtifactActor } from "./artifact-access.server";
import { admitArtifactWrite } from "./agent-artifact-rate-limit.server";
import { resolveArtifactTarget } from "./agent-artifact-target.server";
import {
  saveAttachmentAsArtifact,
  type ArtifactAttachmentPort,
} from "./agent-artifact-save.server";
import { readCommentImage } from "./artifact-comment-images.server";
import { agentPrincipal, personPrincipal } from "./artifact-comment-principal.server";
import { resolveArtifactReference } from "./artifact-reference.server";
import { listComments, readUnseenComments } from "./artifact-comment-reads.server";
import { followArtifact, unfollowArtifact } from "./artifact-follows.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";
import type { ArtifactSignals } from "./artifact-signals.server";
import {
  commentOnArtifact,
  followedByCreate,
  followedByPush,
  reopenArtifactThread,
  reviewArtifact,
  resolveArtifactThread,
} from "./agent-artifact-writes.server";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { ARTIFACT_FILE_LIMIT } from "./artifact-files.server";
import { noteReadPosition, readWithPosition } from "./artifact-read-positions.server";
import type { FileManifest } from "./artifact-manifest.server";
import type { ArtifactDocuments } from "./artifact-documents.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import {
  artifactReadContext,
  artifactWebUrl,
  type ArtifactPresencePort,
} from "./agent-artifact-context.server";

export type AgentArtifactServices = {
  db: PrismaClient;
  documents: Pick<
    ArtifactDocuments,
    | "create"
    | "cards"
    | "list"
    | "listPage"
    | "load"
    | "push"
    | "missingBytes"
    | "remove"
    | "moveToWorkspace"
  >;
  blobs: Pick<StoredArtifactBlobs, "allowed" | "use" | "read" | "upload">;
  enabled: (workspaceId: string) => Promise<boolean>;
  notices?: ArtifactNoticePort | undefined;
  signals?: ArtifactSignals | undefined;
  attachments?: ArtifactAttachmentPort | undefined;
  writeLimit?: AppRateLimit | undefined;
  appOrigin?: (() => string | null) | undefined;
  presence?: ArtifactPresencePort | undefined;
  readActor?: ArtifactActor | undefined;
};

const { id, version, baseVersion, title, description, note, label } = artifactInputs;

const manifestFile = z.object({
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(ARTIFACT_SHA256_PATTERN),
});

const manifest = {
  files: z.array(manifestFile).max(ARTIFACT_FILE_LIMIT).optional(),
  delete: z.array(z.string().min(1).max(1024)).max(ARTIFACT_FILE_LIMIT).optional(),
  entry: z.string().min(1).max(1024).optional(),
};

const LIST_PAGE_DEFAULT = 20;

const PUSH_OVER = z.object({
  artifact: id,
  baseVersion,
  idempotencyKey: id,
  title: title.optional(),
  description: description.optional(),
  note: note.optional(),
  label: label.optional(),
  ...manifest,
});

const MOVE_TARGET_PUBLIC = "public";

const PUSH_NEW = z.object({
  artifact: z.undefined().optional(),
  target: z.string().optional(),
  title,
  description: description.optional(),
  idempotencyKey: id,
  files: z.array(manifestFile).min(1).max(ARTIFACT_FILE_LIMIT),
  entry: manifest.entry,
});

const RULES = {
  list: z.object({
    target: z.string().optional(),
    query: z.string().max(200).optional(),
    after: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  read: z.object({ artifact: id, version: version.optional() }),
  push: PUSH_OVER,
  move: z.object({ artifact: id, to: z.string().max(40) }),
  delete: z.object({ artifact: id }),
  ...commentInputs,
  save: z.object({ attachment: z.string().max(100) }),
  image: z.object({ artifact: id, image: id }),
  follow: z.object({ artifact: id }),
  unfollow: z.object({ artifact: id }),
} satisfies Record<AgentArtifactRequest["operation"], z.ZodType>;

export { ArtifactRateLimited } from "./agent-artifact-rate-limit.server";

const REFERENCE_MAX_CHARS = 2000;
const VERSIONED = new Set(["read", "comment", "review"]);

async function resolvedReference(
  services: AgentArtifactServices,
  principal: { workspaceId: string; agentId: string },
  request: AgentArtifactRequest,
): Promise<AgentArtifactRequest> {
  if (!("artifact" in request) || request.artifact === undefined) return request;
  if (request.artifact.length > REFERENCE_MAX_CHARS)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-request",
      hint: "artifact is too long",
    });
  const readActor: ArtifactActor = services.readActor ?? { agentId: principal.agentId };
  const scope = { workspaceId: principal.workspaceId, actor: readActor };
  const { artifactId, version } = await resolveArtifactReference(
    request.artifact,
    async (name) => (await services.documents.listPage(scope, { title: name, limit: 6 })).artifacts,
  );
  return {
    ...request,
    artifact: artifactId,
    ...(version !== undefined &&
    VERSIONED.has(request.operation) &&
    (request as { version?: number }).version === undefined
      ? { version }
      : {}),
  } as AgentArtifactRequest;
}

export async function runAgentArtifactOperation(
  services: AgentArtifactServices,
  principal: { workspaceId: string; agentId: string },
  asked: AgentArtifactRequest,
) {
  const { workspaceId, agentId } = principal;
  if (!(await services.enabled(workspaceId))) throw artifactsDisabled();
  await admitArtifactWrite(services.writeLimit, agentId, asked.operation);
  const request = await resolvedReference(services, principal, asked);
  const rule =
    request.operation === "push" && request.artifact === undefined
      ? PUSH_NEW
      : RULES[request.operation];
  const parsed = rule.safeParse(withoutOperation(request));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".");
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-request",
      ...(field ? { hint: `${field} is not accepted` } : {}),
    });
  }
  const readActor: ArtifactActor = services.readActor ?? { agentId };
  const readScope = { workspaceId, actor: readActor };
  const scope = { workspaceId, actor: { agentId } };
  const writes = {
    db: services.db,
    blobs: services.blobs,
    notices: services.notices,
    signals: services.signals,
  };
  switch (request.operation) {
    case "list": {
      const { target, after, ...page } = parsed.data as z.infer<typeof RULES.list>;
      const conversationId =
        target === undefined
          ? undefined
          : await resolveArtifactTarget(services.db, principal, target, readActor);
      if (after === undefined && Object.keys(page).length === 0)
        return services.documents.list(readScope, { conversationId });
      return services.documents.listPage(readScope, {
        conversationId,
        ...page,
        ...(after !== undefined && { cursor: after }),
        limit: page.limit ?? LIST_PAGE_DEFAULT,
      });
    }
    case "read": {
      const input = parsed.data as z.infer<typeof RULES.read>;
      const read = await services.documents.load(readScope, {
        artifactId: input.artifact,
        version: input.version,
      });
      const current = (read.version?.number ?? 0) === read.artifact.currentVersion;
      const [unseen, unseenComments, context] = await Promise.all([
        readWithPosition(services.db, {
          artifactId: read.artifact.id,
          agentId,
          workspaceId,
          shown: read.version?.number ?? 0,
          current: read.artifact.currentVersion,
        }),
        current ? unseenCommentsOf(services.db, principal, read.artifact.id) : null,
        artifactReadContext(services.db, {
          workspaceId,
          artifact: read.artifact,
          appOrigin: services.appOrigin,
          presence: services.presence,
        }),
      ]);
      const entryPath = read.version?.entryPath ?? read.artifact.entryPath;
      return {
        ...read,
        ...context,
        entryPath,
        entryKind: artifactKindOfPath(entryPath),
        unseen,
        unseenComments,
      };
    }
    case "push": {
      if (request.artifact === undefined) {
        const input = parsed.data as z.infer<typeof PUSH_NEW>;
        if (input.target === undefined)
          throw new AppError("INVALID_INPUT", {
            errorId: "artifact-target-required",
            hint: "a new artifact needs a home: pass --target with the conversation you are working in (#channel, or @name for a DM)",
          });
        const conversationId = await resolveArtifactTarget(services.db, principal, input.target);
        const files = manifestOf({ files: input.files, entry: input.entry })!;
        const missing = await services.documents.missingBytes(scope, { manifest: files });
        if (missing.length) return { status: "missing" as const, missing };
        const created = await services.documents.create(scope, {
          conversationId,
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          manifest: files,
          idempotencyKey: input.idempotencyKey,
        });
        if (created.currentVersion > 0)
          await noteReadPosition(services.db, { artifactId: created.id, agentId, version: 1 });
        const [followed, url] = await Promise.all([
          followedByCreate(writes, principal, created),
          artifactWebUrl(services.db, workspaceId, created.id, services.appOrigin),
        ]);
        return { ...created, ...followed, ...(url ? { url } : {}) };
      }
      const {
        artifact,
        files,
        delete: deleted,
        entry,
        ...input
      } = parsed.data as z.infer<typeof PUSH_OVER>;
      const fileManifest = manifestOf({ files, delete: deleted, entry });
      const saved = await services.documents.push(
        scope,
        {
          artifactId: artifact,
          ...input,
          ...(fileManifest ? { manifest: fileManifest } : {}),
        },
        {
          afterSave: ({ number }) =>
            noteReadPosition(services.db, { artifactId: artifact, agentId, version: number }),
        },
      );
      const [followed, url] = await Promise.all([
        followedByPush(writes, principal, artifact, saved, input),
        saved.status === "missing"
          ? null
          : artifactWebUrl(services.db, workspaceId, artifact, services.appOrigin),
      ]);
      return {
        ...saved,
        ...(saved.status === "nothing" ? { unchanged: true } : {}),
        ...(saved.status === "replayed" ? { replayed: true } : {}),
        ...followed,
        ...(url ? { url } : {}),
      };
    }
    case "move": {
      const input = parsed.data as z.infer<typeof RULES.move>;
      if (input.to === MOVE_TARGET_PUBLIC)
        throw new AppError("ACCESS_DENIED", {
          errorId: "artifact-move-public",
          hint: "only a person can turn on link sharing",
        });
      if (input.to !== "workspace")
        throw new AppError("INVALID_INPUT", {
          errorId: "artifact-request",
          hint: "to is not accepted: an Agent can only move an artifact to workspace",
        });
      const moved = await services.documents.moveToWorkspace(
        { workspaceId, actor: { agentId } },
        {
          artifactId: input.artifact,
        },
      );
      const url = await artifactWebUrl(
        services.db,
        workspaceId,
        input.artifact,
        services.appOrigin,
      );
      return { ...moved, ...(url ? { url } : {}) };
    }
    case "delete": {
      const input = parsed.data as z.infer<typeof RULES.delete>;
      const artifact = await services.documents.remove(
        { workspaceId, actor: { agentId } },
        { artifactId: input.artifact },
      );
      return { artifact, deleted: true as const };
    }
    case "comments":
      return listComments(
        services.db,
        principal,
        parsed.data as z.infer<typeof RULES.comments>,
        readActor,
      );
    case "comment":
      return commentOnArtifact(writes, principal, parsed.data as z.infer<typeof RULES.comment>);
    case "review":
      return reviewArtifact(writes, principal, parsed.data as z.infer<typeof RULES.review>);
    case "resolve":
      return resolveArtifactThread(writes, principal, parsed.data as z.infer<typeof RULES.resolve>);
    case "reopen":
      return reopenArtifactThread(writes, principal, parsed.data as z.infer<typeof RULES.reopen>);
    case "save": {
      const saved = await saveAttachmentAsArtifact(
        services,
        principal,
        (parsed.data as z.infer<typeof RULES.save>).attachment,
      );
      const url = await artifactWebUrl(
        services.db,
        workspaceId,
        saved.artifact.id,
        services.appOrigin,
      );
      if (!saved.created) return { ...saved, ...(url ? { url } : {}) };
      await noteReadPosition(services.db, { artifactId: saved.artifact.id, agentId, version: 1 });
      return {
        ...saved,
        ...(await followedByCreate(writes, principal, saved.artifact)),
        ...(url ? { url } : {}),
      };
    }
    case "image":
      return readCommentImage(
        services.db,
        services.blobs,
        "userId" in readActor && readActor.userId
          ? personPrincipal({ workspaceId, userId: readActor.userId })
          : agentPrincipal(principal),
        parsed.data as z.infer<typeof RULES.image>,
      );
    case "follow":
      return followArtifact(
        services.db,
        principal,
        (parsed.data as z.infer<typeof RULES.follow>).artifact,
      );
    case "unfollow":
      return unfollowArtifact(
        services.db,
        principal,
        (parsed.data as z.infer<typeof RULES.unfollow>).artifact,
      );
  }
}

async function unseenCommentsOf(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  artifactId: string,
) {
  try {
    return await readUnseenComments(db, { ...principal, artifactId });
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "artifacts:unseen_comments_failed", error_type: errorType(error) }),
    );
    return null;
  }
}

function manifestOf(input: {
  files?: { path: string; sha256: string }[];
  delete?: string[];
  entry?: string;
}): FileManifest | undefined {
  if (input.files === undefined && input.delete === undefined && input.entry === undefined)
    return undefined;
  return {
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(input.delete !== undefined ? { deletedPaths: input.delete } : {}),
    ...(input.entry !== undefined ? { entryPath: input.entry } : {}),
  };
}

function withoutOperation(request: AgentArtifactRequest) {
  const { operation: _operation, ...fields } = request;
  return fields;
}

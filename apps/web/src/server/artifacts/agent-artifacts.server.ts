import { z } from "zod";
import { ARTIFACT_SHA256_PATTERN, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { commentInputs } from "#src/features/artifacts/artifact-comment-inputs";
import { artifactInputs } from "#src/features/artifacts/artifact-inputs";
import { AppError } from "#src/lib/app-error";
import { errorType } from "#src/server/errors/error-type.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  directConversationIdBetween,
  visibleChannelIdByName,
} from "#src/server/conversations/channel-read-access.server";
import { artifactsDisabled } from "./artifact-access.server";
import { listComments, unseenCommentSummary } from "./artifact-comment-reads.server";
import { reopenComment, resolveComment } from "./artifact-comment-threads.server";
import { postComment, postReview } from "./artifact-comments.server";
import { ARTIFACT_FILE_LIMIT } from "./artifact-files.server";
import { noteReadPosition, readWithPosition } from "./artifact-read-positions.server";
import type { FileManifest } from "./artifact-manifest.server";
import type { ArtifactDocuments } from "./artifact-documents.server";

/** What the Agent API's operations run on; production's is `productionArtifacts(db)`. */
export type AgentArtifactServices = {
  db: PrismaClient;
  documents: Pick<
    ArtifactDocuments,
    "create" | "list" | "listPage" | "load" | "push" | "missingBytes"
  >;
  enabled: (workspaceId: string) => Promise<boolean>;
};

const { id, version, baseVersion, title, description, note, label } = artifactInputs;

/** A file a push adds or replaces: its path (its shape only here; the domain judges it) and the
 * sha256 of bytes uploaded before. */
const manifestFile = z.object({
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(ARTIFACT_SHA256_PATTERN),
});

/** A version sent as files: what it adds or replaces, what it deletes, and the file it opens at. */
const manifest = {
  files: z.array(manifestFile).max(ARTIFACT_FILE_LIMIT).optional(),
  delete: z.array(z.string().min(1).max(1024)).max(ARTIFACT_FILE_LIMIT).optional(),
  entry: z.string().min(1).max(1024).optional(),
};

/** A list page: 20 by default and 50 at most. */
const LIST_PAGE_DEFAULT = 20;

/** A push over a version of an artifact. */
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

/** A push of files with no artifact yet, which makes one: the files are its first version. */
const PUSH_NEW = z.object({
  artifact: z.undefined().optional(),
  target: z.string().optional(),
  title,
  description: description.optional(),
  idempotencyKey: id,
  files: z.array(manifestFile).min(1).max(ARTIFACT_FILE_LIMIT),
  entry: manifest.entry,
});

/** The web page's rules, for the same fields (`artifacts.functions.ts`). */
const RULES = {
  list: z.object({
    target: z.string().optional(),
    query: z.string().max(200).optional(),
    after: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  read: z.object({ artifact: id, version: version.optional() }),
  push: PUSH_OVER,
  ...commentInputs,
} satisfies Record<AgentArtifactRequest["operation"], z.ZodType>;

/**
 * One `coforge artifact` operation, as the Agent (task #385). The rules are the web page's: the
 * same input limits, and the artifact service's experiment check and access rules. An Agent
 * writes an artifact only by pushing files: bytes not uploaded yet come back as
 * `{ status: "missing" }`, to upload and send the same request again. The experiment is checked
 * first, so a Workspace without artifacts answers `artifacts-disabled` whatever was asked.
 */
export async function runAgentArtifactOperation(
  services: AgentArtifactServices,
  principal: { workspaceId: string; agentId: string },
  request: AgentArtifactRequest,
) {
  const { workspaceId, agentId } = principal;
  if (!(await services.enabled(workspaceId))) throw artifactsDisabled();
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
  const scope = { workspaceId, actor: { agentId } };
  switch (request.operation) {
    case "list": {
      const { target, after, ...page } = parsed.data as z.infer<typeof RULES.list>;
      const conversationId =
        target === undefined
          ? undefined
          : await resolveArtifactTarget(services.db, principal, target);
      // A request that asks for no page gets the plain list it always did (an older Computer's).
      if (after === undefined && Object.keys(page).length === 0)
        return services.documents.list(scope, { conversationId });
      return services.documents.listPage(scope, {
        conversationId,
        ...page,
        ...(after !== undefined && { cursor: after }),
        limit: page.limit ?? LIST_PAGE_DEFAULT,
      });
    }
    case "read": {
      const input = parsed.data as z.infer<typeof RULES.read>;
      const read = await services.documents.load(scope, {
        artifactId: input.artifact,
        version: input.version,
      });
      // What others published since this Agent last looked, when the current version is read, and
      // the comments of others it has not read, whichever version is.
      const [unseen, unseenComments] = await Promise.all([
        readWithPosition(services.db, {
          artifactId: read.artifact.id,
          agentId,
          workspaceId,
          shown: read.version?.number ?? 0,
          current: read.artifact.currentVersion,
        }),
        unseenCommentsOf(services.db, principal, read.artifact.id),
      ]);
      // The shown version's entry file, beside its files (`files` of `read`).
      return {
        ...read,
        entryPath: read.version?.entryPath ?? read.artifact.entryPath,
        unseen,
        unseenComments,
      };
    }
    case "push": {
      if (request.artifact === undefined) {
        const input = parsed.data as z.infer<typeof PUSH_NEW>;
        const conversationId =
          input.target === undefined
            ? undefined
            : await resolveArtifactTarget(services.db, principal, input.target);
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
        // The Agent has seen what it made: version 1, which a replayed create is also.
        if (created.currentVersion > 0)
          await noteReadPosition(services.db, { artifactId: created.id, agentId, version: 1 });
        return created;
      }
      const {
        artifact,
        files,
        delete: deleted,
        entry,
        ...input
      } = parsed.data as z.infer<typeof PUSH_OVER>;
      const fileManifest = manifestOf({ files, delete: deleted, entry });
      const saved = await services.documents.push(scope, {
        artifactId: artifact,
        ...input,
        ...(fileManifest ? { manifest: fileManifest } : {}),
      });
      // The Agent has seen what it published; a merged push's answer says what was merged.
      if (saved.status === "created" || saved.status === "replayed")
        await noteReadPosition(services.db, {
          artifactId: artifact,
          agentId,
          version: saved.number,
        });
      return saved;
    }
    case "comments":
      return listComments(services.db, principal, parsed.data as z.infer<typeof RULES.comments>);
    case "comment":
      return postComment(services.db, principal, parsed.data as z.infer<typeof RULES.comment>);
    case "review":
      return postReview(services.db, principal, parsed.data as z.infer<typeof RULES.review>);
    case "resolve":
      return resolveComment(services.db, principal, parsed.data as z.infer<typeof RULES.resolve>);
    case "reopen":
      return reopenComment(services.db, principal, parsed.data as z.infer<typeof RULES.reopen>);
  }
}

/** What a read says of the comments the Agent has not read, beside the versions: bookkeeping, so
 * a failure is logged and the read answers `null` for it. */
async function unseenCommentsOf(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  artifactId: string,
) {
  try {
    return await unseenCommentSummary(db, { ...principal, artifactId });
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "artifacts:unseen_comments_failed", error_type: errorType(error) }),
    );
    return null;
  }
}

/** The manifest a push carries, or none when it sends settings only. */
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

const CHANNEL_TARGET = /^#([a-z0-9][a-z0-9_-]{0,63})$/;
/** `@name` as `message send` takes it (`dm:@name` too), with `~human` or `~agent` when a person
 * and an Agent share the name. */
const DM_TARGET = /^(?:dm:)?@([a-z0-9][a-z0-9_-]{0,63})(?:~(human|agent))?$/;

/**
 * The conversation an artifact is made in: `#channel`, or `@name` for the Agent's direct
 * conversation with a person or an Agent (`~human` or `~agent` when both have the name). A thread is not a home (an artifact belongs to its
 * channel), and a DM is not opened for an artifact. A conversation that does not exist answers
 * `NOT_FOUND`; whether the Agent may write there is the artifact service's to answer, with the
 * same `NOT_FOUND` for a channel it cannot read.
 */
export async function resolveArtifactTarget(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  target: string,
): Promise<string> {
  const channel = CHANNEL_TARGET.exec(target)?.[1];
  const [, peer, peerKind] = DM_TARGET.exec(target) ?? [];
  if (!channel && !peer)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-target",
      hint: "name #channel or @name (@name~agent for an Agent), without a thread",
    });
  const { workspaceId, agentId } = principal;
  if (channel) {
    // A lookup only: whether the Agent may write there is the artifact service's to answer.
    const id = await visibleChannelIdByName(db, workspaceId, channel);
    if (id === undefined) throw new AppError("NOT_FOUND");
    return id;
  }
  const [user, agent] = await Promise.all([
    peerKind === "agent"
      ? null
      : db.user.findFirst({
          where: { username: peer, memberships: { some: { workspaceId } } },
          select: { id: true },
        }),
    peerKind === "human"
      ? null
      : db.agent.findFirst({
          where: { workspaceId, name: peer, ...ACTIVE_AGENT_WHERE },
          select: { id: true },
        }),
  ]);
  const otherAgent = agent && agent.id !== agentId ? agent : null;
  // As `message send`: a name a person and an Agent share needs its `~human` or `~agent`.
  if (user && otherAgent)
    throw new AppError("AMBIGUOUS_TARGET", {
      hint: `@${peer} is a person and an Agent: name @${peer}~human or @${peer}~agent`,
    });
  const peerMember = user ? { userId: user.id } : otherAgent ? { agentId: otherAgent.id } : null;
  if (peerMember) {
    const id = await directConversationIdBetween(db, workspaceId, { agentId }, peerMember);
    if (id !== undefined) return id;
  }
  throw new AppError("NOT_FOUND");
}

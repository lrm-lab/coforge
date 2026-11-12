import { z } from "zod";
import { ARTIFACT_SHA256_PATTERN, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactInputs } from "#src/features/artifacts/artifact-inputs";
import {
  ARTIFACT_SHARE_MAX_ARTIFACTS,
  ARTIFACT_SHARE_MAX_TARGETS,
} from "#src/features/artifacts/artifact-share-input";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  directConversationIdBetween,
  visibleChannelIdByName,
} from "#src/server/conversations/channel-read-access.server";
import { artifactsDisabled } from "./artifact-access.server";
import { ARTIFACT_FILE_LIMIT } from "./artifact-files.server";
import { noteReadPosition, readWithPosition } from "./artifact-read-positions.server";
import type { FileManifest } from "./artifact-manifest.server";
import type { ArtifactShares } from "./artifact-shares.server";
import type { ArtifactDocuments } from "./artifact-documents.server";
import type { Artifacts } from "./artifacts.server";

/** What the Agent API's documents run on; production's is `productionArtifacts(db)`. */
export type AgentArtifactServices = {
  db: PrismaClient;
  artifacts: Pick<Artifacts, "history">;
  documents: Pick<
    ArtifactDocuments,
    "create" | "list" | "listPage" | "load" | "save" | "revert" | "missingBytes"
  >;
  shares?: Pick<ArtifactShares, "share">;
  send?: Parameters<ArtifactShares["share"]>[0]["send"];
  enabled: (workspaceId: string) => Promise<boolean>;
};

const { id, version, baseVersion, text, title, description, note, label, historyLimit } =
  artifactInputs;

/** A version sent as files: what it adds or replaces (uploaded bytes by sha256), what it deletes,
 * and the file it opens at. Paths are the domain's to judge; here only their shape. */
const manifest = {
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        sha256: z.string().regex(ARTIFACT_SHA256_PATTERN),
      }),
    )
    .max(ARTIFACT_FILE_LIMIT)
    .optional(),
  delete: z.array(z.string().min(1).max(1024)).max(ARTIFACT_FILE_LIMIT).optional(),
  entry: z.string().min(1).max(1024).optional(),
};

/** A version is one `text` or a manifest, never both (the SDK's decoder refuses the same). */
const textOrManifest = (input: {
  text?: string;
  files?: unknown;
  delete?: unknown;
  entry?: unknown;
}) =>
  input.text === undefined ||
  (input.files === undefined && input.delete === undefined && input.entry === undefined);

/** A list page: 20 by default and 50 at most. */
const LIST_PAGE_DEFAULT = 20;

/** The web page's rules, for the same fields (`artifacts.functions.ts`). */
const RULES = {
  create: z
    .object({
      title,
      target: z.string().optional(),
      kind: z.enum(["markdown", "html"]).optional(),
      description: description.optional(),
      text: text.optional(),
      idempotencyKey: id.optional(),
      ...manifest,
    })
    .refine(textOrManifest, { path: ["text"] }),
  list: z.object({
    target: z.string().optional(),
    query: z.string().max(200).optional(),
    after: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  read: z.object({ artifact: id, version: version.optional() }),
  push: z
    .object({
      artifact: id,
      baseVersion,
      idempotencyKey: id,
      text: text.optional(),
      title: title.optional(),
      description: description.optional(),
      note: note.optional(),
      label: label.optional(),
      ...manifest,
    })
    .refine(textOrManifest, { path: ["text"] }),
  history: z.object({
    artifact: id,
    before: version.optional(),
    limit: historyLimit.optional(),
  }),
  revert: z.object({ artifact: id, to: version, baseVersion: version, idempotencyKey: id }),
  share: z.object({
    artifactIds: z.array(id).min(1).max(ARTIFACT_SHARE_MAX_ARTIFACTS),
    targets: z.array(z.string().trim().min(1).max(200)).min(1).max(ARTIFACT_SHARE_MAX_TARGETS),
    note: note.optional(),
    requestId: id,
  }),
} satisfies Record<AgentArtifactRequest["operation"], z.ZodType>;

/**
 * One `coforge artifact` operation, as the Agent (task #385). The rules are the web page's: the
 * same input limits, and the artifact service's experiment check and access rules. An Agent
 * sends a version as one `text` or as a manifest of uploaded files; bytes not uploaded yet come
 * back as `{ status: "missing" }`, to upload and send the same request again. The experiment is
 * checked first, so a Workspace without documents answers `artifacts-disabled` whatever was
 * asked.
 */
export async function runAgentArtifactOperation(
  services: AgentArtifactServices,
  principal: { workspaceId: string; agentId: string },
  request: AgentArtifactRequest,
) {
  const { workspaceId, agentId } = principal;
  if (!(await services.enabled(workspaceId))) throw artifactsDisabled();
  const parsed = RULES[request.operation].safeParse(withoutOperation(request));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".");
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-request",
      ...(field ? { hint: `${field} is not accepted` } : {}),
    });
  }
  const scope = { workspaceId, actor: { agentId } };
  switch (request.operation) {
    case "create": {
      const input = parsed.data as z.infer<typeof RULES.create>;
      const conversationId =
        input.target === undefined
          ? undefined
          : await resolveArtifactTarget(services.db, principal, input.target);
      const files = manifestOf(input);
      if (files) {
        const missing = await services.documents.missingBytes(scope, {
          manifest: files,
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
        });
        if (missing.length) return { status: "missing" as const, missing };
      }
      const created = await services.documents.create(scope, {
        conversationId,
        title: input.title,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        text: input.text,
        ...(files ? { manifest: files } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      // The Agent has seen what it made: version 1, which a replayed create is also.
      if (created.currentVersion > 0)
        await noteReadPosition(services.db, { artifactId: created.id, agentId, version: 1 });
      return created;
    }
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
      // What others published since this Agent last looked, when the current version is read.
      const unseen = await readWithPosition(services.db, {
        artifactId: read.artifact.id,
        agentId,
        workspaceId,
        shown: read.version?.number ?? 0,
        current: read.artifact.currentVersion,
      });
      // The shown version's entry file, beside its files (`files` of `read`).
      return { ...read, entryPath: read.version?.entryPath ?? read.artifact.entryPath, unseen };
    }
    case "push": {
      const {
        artifact,
        files,
        delete: deleted,
        entry,
        ...input
      } = parsed.data as z.infer<typeof RULES.push>;
      const fileManifest = manifestOf({ files, delete: deleted, entry });
      const saved = await services.documents.save(scope, {
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
    case "history": {
      const { artifact, ...input } = parsed.data as z.infer<typeof RULES.history>;
      return services.artifacts.history({
        workspaceId,
        reader: scope.actor,
        artifactId: artifact,
        ...input,
      });
    }
    case "revert": {
      const { artifact, ...input } = parsed.data as z.infer<typeof RULES.revert>;
      return services.documents.revert({ ...scope, artifactId: artifact, ...input });
    }
    case "share": {
      const input = parsed.data as z.infer<typeof RULES.share>;
      if (!services.shares || !services.send) throw new Error("artifact sharing is unavailable");
      return services.shares.share({
        workspaceId,
        actor: scope.actor,
        ...input,
        send: services.send,
      });
    }
  }
}

/** The manifest a create or push carries, or none when it sends `text` or settings only. */
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
 * The conversation a document is made in: `#channel`, or `@name` for the Agent's direct
 * conversation with a person or an Agent (`~human` or `~agent` when both have the name). A thread is not a home (a document belongs to its
 * channel), and a DM is not opened for a document. A conversation that does not exist answers
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

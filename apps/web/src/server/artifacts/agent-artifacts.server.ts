import { z } from "zod";
import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactInputs } from "#src/features/artifacts/artifact-inputs";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import { artifactsDisabled } from "./artifact-access.server";
import type { ArtifactDocuments } from "./artifact-documents.server";
import type { Artifacts } from "./artifacts.server";

/** What the Agent API's documents run on; production's is `productionArtifacts(db)`. */
export type AgentArtifactServices = {
  db: PrismaClient;
  artifacts: Pick<Artifacts, "history">;
  documents: Pick<ArtifactDocuments, "create" | "list" | "load" | "save" | "revert">;
  enabled: (workspaceId: string) => Promise<boolean>;
};

const { id, version, baseVersion, text, title, description, note, label, historyLimit } =
  artifactInputs;

/** The web page's rules, for the same fields (`artifacts.functions.ts`). */
const RULES = {
  create: z.object({ title, target: z.string().optional(), text: text.optional() }),
  list: z.object({ target: z.string().optional() }),
  read: z.object({ artifact: id, version: version.optional() }),
  push: z.object({
    artifact: id,
    baseVersion,
    idempotencyKey: id,
    text: text.optional(),
    title: title.optional(),
    description: description.optional(),
    note: note.optional(),
    label: label.optional(),
  }),
  history: z.object({
    artifact: id,
    before: version.optional(),
    limit: historyLimit.optional(),
  }),
  revert: z.object({ artifact: id, to: version, baseVersion: version, idempotencyKey: id }),
} satisfies Record<AgentArtifactRequest["operation"], z.ZodType>;

/**
 * One `coforge artifact` operation, as the Agent (task #385). The rules are the web page's: the
 * same input limits, and the artifact service's experiment check, access rules and merge. The
 * experiment is checked first, so a Workspace without documents answers `artifacts-disabled`
 * whatever was asked.
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
      return services.documents.create(scope, {
        conversationId,
        title: input.title,
        text: input.text,
      });
    }
    case "list": {
      const input = parsed.data as z.infer<typeof RULES.list>;
      const conversationId =
        input.target === undefined
          ? undefined
          : await resolveArtifactTarget(services.db, principal, input.target);
      return services.documents.list(scope, { conversationId });
    }
    case "read": {
      const input = parsed.data as z.infer<typeof RULES.read>;
      return services.documents.load(scope, { artifactId: input.artifact, version: input.version });
    }
    case "push": {
      const { artifact, ...input } = parsed.data as z.infer<typeof RULES.push>;
      return services.documents.save(scope, { artifactId: artifact, ...input });
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
  }
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
    const found = await db.conversation.findFirst({
      where: { workspaceId, channelName: channel, ...VISIBLE_CONVERSATION_WHERE },
      select: { id: true },
    });
    if (!found) throw new AppError("NOT_FOUND");
    return found.id;
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
  const peers = [
    ...(user ? [{ userId: user.id }] : []),
    ...(otherAgent ? [{ agentId: otherAgent.id }] : []),
  ];
  for (const member of peers) {
    const found = await db.conversation.findFirst({
      where: {
        workspaceId,
        ...DIRECT_CONVERSATION_WHERE,
        AND: [
          { members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } } },
          { members: { some: { ...member, ...ACTIVE_MEMBER_WHERE } } },
        ],
      },
      select: { id: true },
    });
    if (found) return found.id;
  }
  throw new AppError("NOT_FOUND");
}

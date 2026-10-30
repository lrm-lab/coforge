import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForActor,
  canSeeAgent,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { agentChannelReader } from "#src/server/agents/workspace-assistant-authority.server";
import { visibleChannelWhere } from "./channel-read-access.server";
import { ActionCardError } from "./action-card-error.server";

const UUID_PATTERN = UUID_LIKE_PATTERN;

/** Strips one leading `@` or `#`, if present. */
export function bareHandle(value: string): string {
  return value.startsWith("@") || value.startsWith("#") ? value.slice(1) : value;
}

/** A handle an action names that resolves to nothing in the Workspace (422, `INVALID_HANDLE`). */
function unknownHandle(
  kind: "human" | "agent" | "channel" | "computer",
  value: string,
  field: string,
) {
  return new ActionCardError(422, "INVALID_HANDLE", `unknown ${kind} handle: ${value}`, { field });
}

/**
 * Resolves the handles an Agent-prepared action card names (`@alice`, `#general`, a UUID) to ids,
 * as the Agent who prepares it may see them; a handle that resolves to nothing is an
 * `ActionCardError`.
 */
export class ActionCardHandles {
  constructor(private readonly db: PrismaClient) {}

  async channelExists(workspaceId: string, name: string): Promise<boolean> {
    const channel = await this.db.conversation.findFirst({
      where: { workspaceId, channelName: name },
      select: { id: true },
    });
    return Boolean(channel);
  }

  async resolveHumans(workspaceId: string, values: string[] | undefined, field: string) {
    if (!values?.length) return undefined;
    return Promise.all(
      values.map((value, index) => this.resolveHuman(workspaceId, value, `${field}[${index}]`)),
    );
  }

  /** `agentId` is the Agent preparing the card: whether it can see a private Agent decides how
   * that Agent is refused. */
  async resolveAgents(
    workspaceId: string,
    agentId: string,
    values: string[] | undefined,
    field: string,
  ) {
    if (!values?.length) return undefined;
    const viewer = await agentVisibilityViewerForActor(this.db, workspaceId, { agentId });
    return Promise.all(
      values.map((value, index) =>
        this.resolveAgent(workspaceId, viewer, value, `${field}[${index}]`),
      ),
    );
  }

  async resolveHuman(workspaceId: string, value: string, field: string): Promise<string> {
    const bare = bareHandle(value);
    const user = await this.db.user.findFirst({
      where: {
        ...(UUID_PATTERN.test(bare) ? { id: bare } : { username: bare }),
        memberships: { some: { workspaceId } },
      },
      select: { id: true },
    });
    if (!user) throw unknownHandle("human", value, field);
    return user.id;
  }

  async resolveAgent(
    workspaceId: string,
    viewer: AgentVisibilityViewer,
    value: string,
    field: string,
  ): Promise<string> {
    const bare = bareHandle(value);
    const agent = await this.db.agent.findFirst({
      where: {
        ...(UUID_PATTERN.test(bare) ? { id: bare } : { name: bare }),
        workspaceId,
        ...ACTIVE_AGENT_WHERE,
      },
      select: { id: true, ownerId: true, visibility: true, systemKind: true },
    });
    if (!agent) throw unknownHandle("agent", value, field);
    // Every Agent an action card names becomes a channel member, and a private Agent never is one.
    // As in channel management (and `user info`/`profile show`), a private Agent the caller cannot
    // see is "not visible", and one it can see is refused with the reason; either way its display
    // name stays out of a card rendered to the channel.
    if (!canSeeAgent(viewer, agent))
      throw new ActionCardError(404, "AGENT_NOT_VISIBLE", `${value} is not visible to you.`, {
        field,
      });
    if (agent.visibility !== AGENT_VISIBILITY.PUBLIC)
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `${value} is private and cannot be a channel member`,
        { field },
      );
    return agent.id;
  }

  /** `agentId` is the Agent preparing the card: a private channel it cannot read is unknown. */
  async resolveChannel(
    workspaceId: string,
    agentId: string,
    value: string,
    field: string,
  ): Promise<string> {
    const bare = bareHandle(value);
    const reader = await agentChannelReader(this.db, workspaceId, agentId);
    const channel = await this.db.conversation.findFirst({
      where: {
        ...visibleChannelWhere(workspaceId, reader),
        ...(UUID_PATTERN.test(bare) ? { id: bare } : { channelName: bare }),
      },
      select: { id: true },
    });
    if (!channel) throw unknownHandle("channel", value, field);
    return channel.id;
  }

  async resolveComputer(workspaceId: string, value: string, field: string): Promise<string> {
    const bare = bareHandle(value);
    const link = await this.db.workspaceComputer.findFirst({
      where: {
        workspaceId,
        ...(UUID_PATTERN.test(bare)
          ? { computerId: bare }
          : { computer: { OR: [{ name: bare }, { displayName: bare }] } }),
      },
      select: { computerId: true },
    });
    if (!link) throw unknownHandle("computer", value, field);
    return link.computerId;
  }
}

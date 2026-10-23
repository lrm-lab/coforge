import type {
  AgentProfileRow,
  ChannelProfileRow,
  ComputerProfileRow,
  WorkspaceProfileRow,
} from "#src/server/db/repositories/app-installation-data.repositories.server";
import type { ComputerKind } from "#src/features/computers/computer-identity";
import { defaultAgentAvatarUrl } from "#src/features/agents/agent-default-avatar";
import {
  PROFILE_IMAGE_STYLES,
  type ProfileImageStyle,
  publicImageUrl,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";

/** What each projection reads, already filtered to what an app may see (see `docs/authorization-server/app-installation-data.md`). */
export interface AppInstallationDataStore {
  workspace(workspaceId: string): Promise<WorkspaceProfileRow | undefined>;
  agents(workspaceId: string): Promise<AgentProfileRow[]>;
  channels(workspaceId: string): Promise<ChannelProfileRow[]>;
  computers(workspaceId: string): Promise<ComputerProfileRow[]>;
}

/** Whether each Computer of the Workspace is online now, in the scopes' order. */
export type ComputerPresence = (
  scopes: { workspaceId: string; computerId: string }[],
) => Promise<boolean[]>;

/**
 * What an app installed in a Workspace may read once the Workspace approved a group: a profile of
 * the Workspace, its public Agents, its public channels and its Computers. Each projection names
 * its fields; none carries a person, a role, a message, a count, or how anything is configured.
 * An image is its public CDN URL, or `null` where the deployment has no image CDN: the
 * authenticated route the Web falls back to is useless to an app. An Agent without its own upload
 * has the platform default picture, which the Web serves publicly beside `issuer`.
 */
export class AppInstallationData {
  constructor(
    private readonly store: AppInstallationDataStore,
    private readonly presence: ComputerPresence,
    private readonly issuer: string,
    private readonly imageUrl: PublicImageUrlResolver = publicImageUrl,
  ) {}

  async workspace(workspaceId: string) {
    const workspace = await this.store.workspace(workspaceId);
    if (!workspace) return undefined;
    return {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      picture_url: this.picture(workspace.iconObjectKey, PROFILE_IMAGE_STYLES.icon),
      created_at: workspace.createdAt.toISOString(),
    };
  }

  async agents(workspaceId: string) {
    const agents = await this.store.agents(workspaceId);
    return agents.map((agent) => ({
      id: agent.id,
      handle: agent.name,
      display_name: agent.displayName,
      description: agent.description,
      avatar_url: agent.avatarObjectKey
        ? this.picture(agent.avatarObjectKey, PROFILE_IMAGE_STYLES.avatar)
        : new URL(defaultAgentAvatarUrl(agent.id), this.issuer).href,
      created_at: agent.createdAt.toISOString(),
    }));
  }

  async channels(workspaceId: string) {
    const channels = await this.store.channels(workspaceId);
    return channels.map((channel) => ({
      id: channel.id,
      name: channel.channelName,
      description: channel.description,
      created_at: channel.createdAt.toISOString(),
    }));
  }

  async computers(workspaceId: string) {
    const computers = await this.store.computers(workspaceId);
    const online = await this.presence(
      computers.map((computer) => ({ workspaceId, computerId: computer.id })),
    );
    return computers.map((computer, index) => ({
      id: computer.id,
      name: computer.displayName.trim() || computer.name.trim() || "Computer",
      kind: toComputerKind(computer.kind),
      computer_version: computer.computerVersion,
      online: online[index] ?? false,
    }));
  }

  private picture(objectKey: string | null, style: ProfileImageStyle) {
    return objectKey ? this.imageUrl(objectKey, style) : null;
  }
}

/** `Computer.kind` is a free string column that only ever holds these two values. */
function toComputerKind(kind: string): ComputerKind {
  return kind === "cloud" ? "cloud" : "local";
}

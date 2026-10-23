import { appNotificationsPossible } from "#src/server/app-notifications/app-notifications.server";
import { recordAgentProfileUpdated } from "#src/server/app-notifications/agent-events.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import type { FileStorage } from "#src/server/files/file-storage.server";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  publicImageUrlOrFallback,
  versionedImagePath,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { validateImage } from "#src/server/files/image-upload.server";
import { replaceStoredImage } from "#src/server/files/stored-image-replacement.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { defaultAgentAvatarUrl } from "#src/features/agents/agent-default-avatar";
import { agentVisibilityViewerForUser, assertAgentVisible } from "./agent-visibility.server";

/**
 * Where the browser reads an Agent avatar. Its own upload has the same delivery as a User avatar:
 * the image CDN when this deployment has one, otherwise the authenticated Workspace route
 * versioned by the object id. An Agent without one shows the platform default picture the app
 * ships. Bytes never live in PostgreSQL.
 */
export function agentAvatarUrl(
  workspaceId: string,
  agentId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  return (
    publicImageUrlOrFallback(
      objectKey,
      PROFILE_IMAGE_STYLES.avatar,
      (key) => versionedImagePath(`/api/workspaces/${workspaceId}/agents/${agentId}/avatar`, key),
      publicUrl,
    ) ?? defaultAgentAvatarUrl(agentId)
  );
}

function avatarObjectKey(workspaceId: string, agentId: string, version = crypto.randomUUID()) {
  return `workspaces/${workspaceId}/agents/${agentId}/avatars/${version}/original`;
}

/**
 * The creator's picture of one Agent. Workspace members may read it; only the creator may
 * replace or remove it. A deleted Agent has no picture to change.
 */
export class AgentAvatars {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: () => Promise<FileStorage> = getPublicImageStorage,
  ) {}

  async store(workspaceId: string, userId: string, agentId: string, file: File) {
    await validateImage(file);
    const current = await this.#owned(workspaceId, userId, agentId);
    const objectKey = avatarObjectKey(workspaceId, agentId);
    await replaceStoredImage({
      storage: await this.storage(),
      objectKey,
      file,
      contentType: file.type,
      previousObjectKey: current.avatarObjectKey,
      commit: async () => {
        const updated = await this.#write(workspaceId, agentId, current.avatarObjectKey, {
          avatarObjectKey: objectKey,
          avatarContentType: file.type,
        });
        if (!updated) throw new AppError("CONFLICT");
      },
      reportRemovalFailure: (error) => void toPublicServerError(error),
    });
    return { avatarUrl: agentAvatarUrl(workspaceId, agentId, objectKey) };
  }

  async remove(workspaceId: string, userId: string, agentId: string) {
    const current = await this.#owned(workspaceId, userId, agentId);
    await this.#write(workspaceId, agentId, current.avatarObjectKey, {
      avatarObjectKey: null,
      avatarContentType: null,
    });
    if (current.avatarObjectKey) {
      try {
        await (await this.storage()).remove(current.avatarObjectKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
  }

  /** Compare-and-swap on the picture this change replaces; records `agent.profile_updated` for
   * the apps installed when it wins. Says whether it did. */
  async #write(
    workspaceId: string,
    agentId: string,
    replacing: string | null,
    data: { avatarObjectKey: string | null; avatarContentType: string | null },
  ) {
    const where = { id: agentId, avatarObjectKey: replacing };
    if (!appNotificationsPossible() || replacing === data.avatarObjectKey)
      return (await this.db.agent.updateMany({ where, data })).count > 0;
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.agent.updateMany({ where, data });
      if (count) await recordAgentProfileUpdated(tx, workspaceId, agentId, ["avatar"]);
      return count > 0;
    });
  }

  async read(userId: string, workspaceId: string, agentId: string) {
    const viewer = await agentVisibilityViewerForUser(this.db, workspaceId, userId);
    if (!viewer.role) throw new AppError("NOT_FOUND");
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: {
        ownerId: true,
        visibility: true,
        systemKind: true,
        avatarObjectKey: true,
        avatarContentType: true,
      },
    });
    if (!agent) throw new AppError("NOT_FOUND");
    assertAgentVisible(viewer, agent);
    if (!agent.avatarObjectKey || !agent.avatarContentType) throw new AppError("NOT_FOUND");
    const file = await (await this.storage()).open(agent.avatarObjectKey);
    if (!file) throw new AppError("NOT_FOUND");
    return { body: file.body, contentType: agent.avatarContentType };
  }

  async #owned(workspaceId: string, userId: string, agentId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { ownerId: true, avatarObjectKey: true },
    });
    if (!agent) throw new AppError("NOT_FOUND");
    if (agent.ownerId !== userId) throw new AppError("ACCESS_DENIED");
    return agent;
  }
}

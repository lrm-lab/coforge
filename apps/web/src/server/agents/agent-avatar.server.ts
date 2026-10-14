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
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import {
  AGENT_AVATAR_POOL_VERSION,
  agentAvatarPictureById,
  randomAgentAvatarPicture,
} from "./agent-avatar-pictures.server";
import { agentVisibilityViewerForUser, assertAgentVisible } from "./agent-visibility.server";

/**
 * Where the browser reads an Agent avatar. Same delivery as a User avatar: the image CDN when
 * this deployment has one, otherwise the authenticated Workspace route versioned by the object
 * id. Bytes never live in PostgreSQL.
 */
export function agentAvatarUrl(
  workspaceId: string,
  agentId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  return publicImageUrlOrFallback(
    objectKey,
    PROFILE_IMAGE_STYLES.avatar,
    (key) => versionedImagePath(`/api/workspaces/${workspaceId}/agents/${agentId}/avatar`, key),
    publicUrl,
  );
}

function avatarObjectKey(workspaceId: string, agentId: string, version = crypto.randomUUID()) {
  return `workspaces/${workspaceId}/agents/${agentId}/avatars/${version}/original`;
}

/**
 * A copy of a platform picture says so in its object key: the version segment (also the `?v=` of
 * its URL) is `platform-<pool version>-<picture id>-<uuid>`, where an upload's is a bare uuid. That
 * is the only record of where an avatar came from, and it is what lets a later job replace every
 * platform-assigned avatar without touching one a creator uploaded. Keep the shape stable.
 */
const PLATFORM_AVATAR_SEGMENT =
  /^platform-(v\d+)-(ai-\d{2})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The pool version and picture a platform-assigned avatar key records; null for an upload, a
 * missing key, or a malformed one. */
export function parsePlatformAvatarKey(
  objectKey: string | null,
): { version: string; pictureId: string } | null {
  const segments = objectKey?.split("/") ?? [];
  const match = PLATFORM_AVATAR_SEGMENT.exec(segments.at(-2) ?? "");
  return match ? { version: match[1]!, pictureId: match[2]! } : null;
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

  /**
   * Stores the random AI picture a new Agent starts with, before the Agent row exists, so the
   * create can write the key in one step. A picture is a nicety, so a failure is reported and
   * answered with null (the Agent shows its initials) rather than failing the create.
   */
  async storeInitial(workspaceId: string, agentId: string) {
    try {
      const { id, file } = await randomAgentAvatarPicture();
      const objectKey = avatarObjectKey(
        workspaceId,
        agentId,
        `platform-${AGENT_AVATAR_POOL_VERSION}-${id}-${crypto.randomUUID()}`,
      );
      await (await this.storage()).put(objectKey, file, file.type);
      return { objectKey, contentType: file.type };
    } catch (error) {
      toPublicServerError(error);
      return null;
    }
  }

  /** Removes a picture `storeInitial` stored for an Agent whose create then failed. */
  async discard(objectKey: string) {
    try {
      await (await this.storage()).remove(objectKey);
    } catch (error) {
      toPublicServerError(error);
    }
  }

  async store(workspaceId: string, userId: string, agentId: string, file: File) {
    await validateImage(file);
    const current = await this.#owned(workspaceId, userId, agentId);
    const objectKey = avatarObjectKey(workspaceId, agentId);
    const files = await this.storage();
    await files.put(objectKey, file, file.type);
    try {
      const updated = await this.db.agent.updateMany({
        where: { id: agentId, avatarObjectKey: current.avatarObjectKey },
        data: { avatarObjectKey: objectKey, avatarContentType: file.type },
      });
      if (!updated.count) throw new AppError("CONFLICT");
    } catch (error) {
      await files.remove(objectKey);
      throw error;
    }
    if (current.avatarObjectKey) {
      try {
        await files.remove(current.avatarObjectKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
    return { avatarUrl: agentAvatarUrl(workspaceId, agentId, objectKey) };
  }

  /**
   * The creator picks one of the pool's pictures for their Agent. It is stored exactly like an
   * upload (a bare-uuid key), not like a platform assignment, so replacing every platform avatar
   * later leaves it alone.
   */
  async storeChosen(workspaceId: string, userId: string, agentId: string, pictureId: string) {
    const file = await agentAvatarPictureById(pictureId);
    // Authorization first, so a stranger learns nothing about which ids exist.
    await this.#owned(workspaceId, userId, agentId);
    if (!file) throw new AppError("INVALID_INPUT");
    return this.store(workspaceId, userId, agentId, file);
  }

  async remove(workspaceId: string, userId: string, agentId: string) {
    const current = await this.#owned(workspaceId, userId, agentId);
    await this.db.agent.updateMany({
      where: { id: agentId, avatarObjectKey: current.avatarObjectKey },
      data: { avatarObjectKey: null, avatarContentType: null },
    });
    if (current.avatarObjectKey) {
      try {
        await (await this.storage()).remove(current.avatarObjectKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
  }

  async read(userId: string, workspaceId: string, agentId: string) {
    const viewer = await agentVisibilityViewerForUser(this.db, workspaceId, userId);
    if (!viewer.role) throw new AppError("NOT_FOUND");
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: {
        ownerId: true,
        visibility: true,
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

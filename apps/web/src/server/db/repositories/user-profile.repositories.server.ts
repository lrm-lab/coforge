import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { avatarPresetUrl, isAvatarPresetReference } from "#src/features/profiles/avatar-presets";
import { personAvatarUrl } from "#src/lib/person-picture";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  publicImageUrlOrFallback,
  versionedImagePath,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";

export class PrismaUserProfileRepository {
  constructor(private readonly db: PrismaClient) {}

  async get(userId: string) {
    const profile = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
        createdAt: true,
        welcomedAt: true,
        email: true,
        emailVerified: true,
        phone: true,
        phoneVerified: true,
      },
    });
    if (!profile) throw new AppError("NOT_FOUND");
    return {
      /** The name teammates see for this person (`humanLabel`); never the sign-in provider's. */
      name: humanLabel(profile),
      /** Only for a caller that needs the handle itself (Records names its viewer by it); no page
       * shows it. */
      username: profile.username,
      displayName: profile.displayName,
      /** False until the person has confirmed their name (first sign-in). */
      named: profile.welcomedAt !== null,
      description: profile.description,
      avatarUrl: avatarUrl(userId, profile.avatarObjectKey),
      /** False while the person has no avatar of their own: `avatarUrl` is then their default cartoon. */
      hasAvatar: profile.avatarObjectKey !== null,
      /** When the account was created, as an ISO instant. */
      joinedAt: profile.createdAt.toISOString(),
      /** The email and phone number the identity provider last reported, each with whether it
       * verified them (null until it has said); only the person themselves is shown these. */
      email: profile.email,
      emailVerified: profile.emailVerified,
      phone: profile.phone,
      phoneVerified: profile.phoneVerified,
    };
  }

  async set(userId: string, input: { displayName: string; description: string }) {
    const profile = await this.db.user
      .update({
        where: { id: userId },
        data: { displayName: input.displayName, description: input.description },
        select: { description: true },
      })
      .catch((error: unknown) => {
        // The signed-in person's row is gone (P2025): the same answer `get` gives.
        throw hasErrorCode(error, "P2025") ? new AppError("NOT_FOUND") : error;
      });
    return {
      name: input.displayName,
      displayName: input.displayName,
      description: profile.description,
    };
  }
}

/**
 * Where the browser reads this user's avatar. With an image CDN configured that is the object's
 * own public URL, identical on every render so one cached copy serves every page; without one it
 * is this deployment's authenticated route, versioned by the object id because the bytes behind
 * one avatar id never change. Never null: without an avatar (or with a preset this build does not
 * ship) it is the cartoon person the user's id chooses, `personAvatarUrl`.
 */
export function avatarUrl(
  userId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  return personAvatarUrl(
    userId,
    publicImageUrlOrFallback(
      objectKey,
      PROFILE_IMAGE_STYLES.avatar,
      (key) => versionedImagePath(`/api/me/avatar`, key),
      publicUrl,
    ),
  );
}

/**
 * Where an app with no session on this deployment can read this user's avatar (Login with
 * CoForge's `picture`): the image CDN's URL, or a platform picture the app serves publicly (a path
 * on this origin, which the userinfo answer makes absolute against the issuer): the preset they
 * chose, else, with no avatar or a preset this build does not ship, the cartoon person their id
 * chooses (`personAvatarUrl`). Null only for an upload, which only this deployment's authenticated
 * route serves.
 */
export function publicAvatarUrl(
  userId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
): string | null {
  if (!objectKey) return personAvatarUrl(userId, null);
  if (isAvatarPresetReference(objectKey)) {
    return avatarPresetUrl(objectKey) ?? personAvatarUrl(userId, null);
  }
  return publicUrl(objectKey, PROFILE_IMAGE_STYLES.avatar);
}

/** `avatarUrl` for a teammate: the upload falls back to the Workspace-scoped route, and with no
 * avatar the picture is the cartoon person the user's id chooses (never null). */
export function workspaceUserAvatarUrl(
  workspaceId: string,
  userId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  return personAvatarUrl(
    userId,
    publicImageUrlOrFallback(
      objectKey,
      PROFILE_IMAGE_STYLES.avatar,
      (key) => versionedImagePath(`/api/workspaces/${workspaceId}/users/${userId}/avatar`, key),
      publicUrl,
    ),
  );
}

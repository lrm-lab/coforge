import {
  avatarPresetReference,
  isAvatarPresetId,
  isAvatarPresetReference,
} from "#src/features/profiles/avatar-presets";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { avatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import type { FileStorage } from "#src/server/files/file-storage.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { validateImage } from "#src/server/files/image-upload.server";
import { replaceStoredImage } from "#src/server/files/stored-image-replacement.server";

export { IMAGE_MAX_BYTES as PROFILE_IMAGE_MAX_BYTES } from "#src/server/files/image-upload.server";

export async function storeUserAvatar(
  db: PrismaClient,
  input: { userId: string; file: File },
  storage: () => Promise<FileStorage> = getPublicImageStorage,
) {
  await validateImage(input.file);
  const previous = await db.user.findUnique({
    where: { id: input.userId },
    select: { avatarObjectKey: true },
  });
  if (!previous) throw new AppError("NOT_FOUND");

  const id = crypto.randomUUID();
  const objectKey = `users/${input.userId}/avatars/${id}/original`;
  await replaceStoredImage({
    storage: await storage(),
    objectKey,
    file: input.file,
    contentType: input.file.type,
    previousObjectKey: storedAvatarObjectKey(previous.avatarObjectKey),
    commit: async () => {
      await db.user.update({
        where: { id: input.userId },
        data: { avatarObjectKey: objectKey, avatarContentType: input.file.type },
      });
    },
    // A replaced avatar's object that cannot be removed fails the request, as removing one does.
    reportRemovalFailure: (error) => {
      throw error;
    },
  });
  return { avatarUrl: avatarUrl(input.userId, objectKey) };
}

/** Makes one of the platform's own pictures the avatar. It already ships with the app, so only
 * its reference is stored; the image store gains nothing and loses the upload it replaces. */
export async function chooseUserAvatarPreset(
  db: PrismaClient,
  input: { userId: string; presetId: string },
  storage: () => Promise<FileStorage> = getPublicImageStorage,
) {
  if (!isAvatarPresetId(input.presetId)) throw new AppError("INVALID_INPUT");
  const previous = await db.user.findUnique({
    where: { id: input.userId },
    select: { avatarObjectKey: true },
  });
  if (!previous) throw new AppError("NOT_FOUND");

  const reference = avatarPresetReference(input.presetId);
  await db.user.update({
    where: { id: input.userId },
    data: { avatarObjectKey: reference, avatarContentType: null },
  });
  await removeStoredAvatar(previous.avatarObjectKey, storage);
  return { avatarUrl: avatarUrl(input.userId, reference) };
}

export async function readUserAvatar(
  db: PrismaClient,
  userId: string,
  storage: () => Promise<FileStorage> = getPublicImageStorage,
) {
  const profile = await db.user.findUnique({
    where: { id: userId },
    select: { avatarObjectKey: true, avatarContentType: true },
  });
  if (!profile?.avatarObjectKey || !profile.avatarContentType) throw new AppError("NOT_FOUND");
  const file = await (await storage()).open(profile.avatarObjectKey);
  if (!file) throw new AppError("NOT_FOUND");
  return { body: file.body, contentType: profile.avatarContentType };
}

export async function removeUserAvatar(
  db: PrismaClient,
  userId: string,
  storage: () => Promise<FileStorage> = getPublicImageStorage,
) {
  const previous = await db.user.findUnique({
    where: { id: userId },
    select: { avatarObjectKey: true },
  });
  if (!previous) throw new AppError("NOT_FOUND");
  await db.user.update({
    where: { id: userId },
    data: { avatarObjectKey: null, avatarContentType: null },
  });
  await removeStoredAvatar(previous.avatarObjectKey, storage);
}

/** The object a stored avatar key names; a preset reference names none. */
function storedAvatarObjectKey(key: string | null): string | null {
  return key && !isAvatarPresetReference(key) ? key : null;
}

/** Deletes a replaced avatar's object; a preset reference names no object, so it deletes nothing. */
async function removeStoredAvatar(
  key: string | null,
  storage: () => Promise<FileStorage>,
): Promise<void> {
  const objectKey = storedAvatarObjectKey(key);
  if (!objectKey) return;
  await (await storage()).remove(objectKey);
}

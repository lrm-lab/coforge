import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaUserProfileRepository } from "#src/server/db/repositories/user-profile.repositories.server";
import { chooseUserAvatarPreset } from "#src/server/profiles/user-avatar.server";
import { saveProfileAndRenameAssistants } from "#src/server/agents/owner-profile-writes.server";
import { saveUserProfileInputSchema } from "./profile.schemas";

function profiles() {
  const db = requireDatabaseClient();
  return new PrismaUserProfileRepository(db);
}

export const getUserProfile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const profile = await profiles().get(user.id);
    return {
      id: user.id,
      name: profile.name,
      username: profile.username,
      named: profile.named,
      displayName: profile.displayName,
      email: profile.email,
      emailVerified: profile.emailVerified,
      phone: profile.phone,
      phoneVerified: profile.phoneVerified,
      description: profile.description,
      avatarUrl: profile.avatarUrl,
      hasAvatar: profile.hasAvatar,
      joinedAt: profile.joinedAt,
    };
  });

/** Saving the display name renames the person's owner-named assistants in the same transaction
 * (task #495), so their names track the owner at once instead of on the next Members read. */
export const saveUserProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(saveUserProfileInputSchema)
  .handler(({ data, context }) =>
    saveProfileAndRenameAssistants(requireDatabaseClient(), context.user.id, data),
  );

/** Makes one of the platform's own pictures the current user's avatar. */
export const chooseAvatarPreset = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ presetId: z.string() }))
  .handler(async ({ data, context }) =>
    chooseUserAvatarPreset(requireDatabaseClient(), {
      userId: context.user.id,
      presetId: data.presetId,
    }),
  );

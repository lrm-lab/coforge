import { createServerFn } from "@tanstack/react-start";
import {
  saveDateTimePreferencesInputSchema,
  saveLanguagePreferencesInputSchema,
} from "./settings.schemas";

import { authMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "#src/server/db/repositories/user-preferences.repositories.server";
import { setLanguageAndRenameAssistants } from "#src/server/agents/owner-profile-writes.server";

function preferences() {
  const db = requireDatabaseClient();
  return new UserPreferences(new PrismaUserPreferencesRepository(db));
}

export const getUserPreferences = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => preferences().read(context.user.id));

/** The Language & region page saves its Date & time group as one unit. */
export const saveDateTimePreferences = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(saveDateTimePreferencesInputSchema)
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return {
      timeZone: await preferences().set(userId, data.timeZone),
      timeFormat: await preferences().setTimeFormat(userId, data.timeFormat),
    };
  });

/** The Language & region page's language switch: the one stored source for outbound text too.
 * Changing it renames the person's owner-named assistants in the same transaction (task #495). */
export const saveLanguagePreference = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(saveLanguagePreferencesInputSchema)
  .handler(({ data, context }) =>
    setLanguageAndRenameAssistants(requireDatabaseClient(), context.user.id, data.language),
  );

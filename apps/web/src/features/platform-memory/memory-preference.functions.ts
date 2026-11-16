import { createServerFn } from "@tanstack/react-start";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { z } from "zod";
import { authMiddleware } from "#src/features/auth/function-auth";
import {
  readPlatformMemoryPreference,
  savePlatformMemoryPreference,
} from "#src/server/db/repositories/platform-memory-preferences.repositories.server";

export const getMemoryPreference = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => readPlatformMemoryPreference(requireDatabaseClient(), context.user.id));

export const setMemoryPreference = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ enabled: z.boolean() }).strict())
  .handler(({ context, data }) =>
    savePlatformMemoryPreference(requireDatabaseClient(), context.user.id, data.enabled),
  );

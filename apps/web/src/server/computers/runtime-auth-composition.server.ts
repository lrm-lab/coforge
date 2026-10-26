import { randomBytes } from "node:crypto";

import type { PrismaClient } from "#src/generated/prisma/client";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RuntimeAuth } from "./runtime-auth.server";
import { PrismaRuntimeAuthAuthorization } from "./runtime-auth-authorization.server";
import { runtimeAuthCapabilitySupport } from "./runtime-auth-capability.server";
import { RedisRuntimeAuthStore } from "./runtime-auth-store.server";

let store: RedisRuntimeAuthStore | undefined;

/** The `RuntimeAuth` the signed-in user's Server Functions and the daemon's reports go through. */
export function userRuntimeAuth(db: PrismaClient) {
  store ??= new RedisRuntimeAuthStore(openRedisClient(redisUrlFor("Runtime auth state")));
  return new RuntimeAuth(
    new PrismaRuntimeAuthAuthorization(db),
    store,
    createCentrifugoServerApi(),
    getComputerStatusCache(),
    runtimeAuthCapabilitySupport,
    () => `rtl_${randomBytes(24).toString("base64url")}`,
  );
}

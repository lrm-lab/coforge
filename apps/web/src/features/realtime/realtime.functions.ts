import { createServerFn } from "@tanstack/react-start";

import { issueBrowserRealtimeToken } from "#src/server/auth/browser-realtime-token.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";

export const getBrowserRealtimeConnectionToken = createServerFn({
  method: "GET",
})
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueBrowserRealtimeToken({ userId: user.id, workspaceId });
  });

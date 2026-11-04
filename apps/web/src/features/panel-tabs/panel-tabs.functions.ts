import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  PrismaWorkspaceMemberPreferencesRepository,
  WorkspaceMemberPreferences,
} from "#src/server/db/repositories/workspace-member-preferences.repositories.server";
import { TAB_ORDER_PANELS } from "./panel-tab-order";

export const savePanelTabOrder = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ panel: z.enum(TAB_ORDER_PANELS), order: z.array(z.string()).max(16) }))
  .handler(({ data, context: { user, db, workspaceId } }) =>
    new WorkspaceMemberPreferences(new PrismaWorkspaceMemberPreferencesRepository(db)).setTabOrder(
      workspaceId,
      user.id,
      data.panel,
      data.order,
    ),
  );

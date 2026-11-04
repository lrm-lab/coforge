import type { PrismaClient } from "#src/generated/prisma/client";

import { AppError } from "#src/lib/app-error";
import {
  isTabOrder,
  knownTabs,
  type TabOrderPanel,
  type TabOrders,
} from "#src/features/panel-tabs/panel-tab-order";

export type WorkspaceMemberPreferencesRepository = {
  /** The member's one row in this Workspace; nothing saved reads as every setting at its default. */
  get(
    workspaceId: string,
    userId: string,
  ): Promise<{ tabOrders: Record<TabOrderPanel, string[]>; setupPending: boolean }>;
  setTabOrder(
    workspaceId: string,
    userId: string,
    panel: TabOrderPanel,
    order: string[],
  ): Promise<void>;
};

const TAB_ORDER_COLUMNS = {
  conversation: "conversationTabOrder",
  agentProfile: "agentProfileTabOrder",
} as const satisfies Record<TabOrderPanel, string>;

export class PrismaWorkspaceMemberPreferencesRepository implements WorkspaceMemberPreferencesRepository {
  constructor(private readonly db: PrismaClient) {}

  async get(workspaceId: string, userId: string) {
    // A member without a row has never saved a preference in this Workspace.
    const saved = await this.db.workspaceMemberPreference.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return {
      tabOrders: {
        conversation: saved?.conversationTabOrder ?? [],
        agentProfile: saved?.agentProfileTabOrder ?? [],
      },
      setupPending: Boolean(saved?.onboardingPendingSince),
    };
  }

  async setTabOrder(workspaceId: string, userId: string, panel: TabOrderPanel, order: string[]) {
    const data = { [TAB_ORDER_COLUMNS[panel]]: order };
    await this.db.workspaceMemberPreference.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, ...data },
      update: data,
    });
  }
}

/**
 * A Workspace member's own settings in that Workspace: the panels' tab orders, and whether the
 * first-sign-in setup wizard is still pending (`onboardingPendingSince`), read from the same row
 * so the Workspace page asks for neither twice.
 */
export class WorkspaceMemberPreferences {
  constructor(private readonly repository: WorkspaceMemberPreferencesRepository) {}

  /** Saved tab orders, keeping only ids that are still tabs of their panel, and the wizard mark. */
  async get(
    workspaceId: string,
    userId: string,
  ): Promise<{ tabOrders: TabOrders; setupPending: boolean }> {
    const saved = await this.repository.get(workspaceId, userId);
    return {
      tabOrders: {
        conversation: knownTabs("conversation", saved.tabOrders.conversation),
        agentProfile: knownTabs("agentProfile", saved.tabOrders.agentProfile),
      },
      setupPending: saved.setupPending,
    };
  }

  async setTabOrder(workspaceId: string, userId: string, panel: TabOrderPanel, order: string[]) {
    if (!isTabOrder(panel, order)) throw new AppError("INVALID_INPUT");
    await this.repository.setTabOrder(workspaceId, userId, panel, order);
  }
}

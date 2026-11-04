import type { PrismaClient } from "#src/generated/prisma/client";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { PersonRole } from "#src/features/onboarding/person-role";
import {
  agentRuntimeConfig,
  assertProviderSelectable,
} from "#src/server/agents/agent-runtime-config.server";
import { computerCanRunAgent } from "#src/server/agents/computer-runtime-availability.server";
import { workspaceAssistantOnboarding } from "#src/server/agents/workspace-assistant-onboarding.server";
import { NEVER_RAN, WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { listComputerConnections } from "#src/server/computers/computer-connections.server";
import { PrismaDeviceAuthorizationStore } from "#src/server/db/repositories/device-auth.repositories.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "#src/server/db/repositories/user-preferences.repositories.server";

/** How long an approved device sign-in still counts as the connect step's attempt. */
const DEVICE_APPROVAL_WINDOW_MS = 30 * 60_000;

/** The runtime and model the member picked for their assistant in the wizard. */
export type AssistantRuntimeChoice = {
  computerId: string;
  provider: RuntimeProvider;
  model: string;
  modelProvider: string;
  reasoning: string;
  fastMode?: boolean;
};

type WizardPorts = {
  /** Which of these Computers are online now (the Computers page's own status cache). */
  online(scopes: { workspaceId: string; computerId: string }[]): Promise<boolean[]>;
  /** Whether the Computer can run this runtime for this person (the Agent forms' own check). */
  canRun(input: {
    workspaceId: string;
    userId: string;
    computerId: string;
    provider: RuntimeProvider;
    model: string;
    modelProvider: string;
    reasoning: string;
  }): Promise<boolean>;
  /** Starts the assistant so it introduces itself; returns it and its DM. */
  startAssistant(
    workspaceId: string,
    userId: string,
  ): Promise<{ agentId: string; conversationId: string }>;
};

/**
 * The first-sign-in setup wizard, server side (`docs/design/onboarding-wizard.md`): its state,
 * the assistant's configuration while it has never run, and completion.
 */
export class OnboardingWizard {
  constructor(
    private readonly db: PrismaClient,
    private readonly ports: WizardPorts,
  ) {}

  private key(workspaceId: string, userId: string) {
    return { workspaceId_userId: { workspaceId, userId } };
  }

  async #pendingSince(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: this.key(workspaceId, userId),
      select: { preferences: { select: { onboardingPendingSince: true } } },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
    return membership.preferences?.onboardingPendingSince ?? null;
  }

  /** The connect step's computers, each with its status and the runtimes the member may use. */
  computers(workspaceId: string, userId: string) {
    return listComputerConnections(
      this.db,
      { workspaceId, userId },
      { online: this.ports.online, runtimes: true },
    );
  }

  /** Whether the member approved a Computer's device sign-in lately: the connect step's first live
   * check, ahead of the Computer itself appearing. */
  deviceApproved(userId: string, now = new Date()) {
    return new PrismaDeviceAuthorizationStore(this.db).approvedSince(
      userId,
      new Date(now.getTime() - DEVICE_APPROVAL_WINDOW_MS),
    );
  }

  /**
   * What the wizard opens with, or null when the member is not in it. The first step's computers
   * and the assistant's name and face come together, so the wizard needs no request of its own to show.
   */
  async state(workspaceId: string, userId: string) {
    if (!(await this.#pendingSince(workspaceId, userId))) return null;
    const [session, computers] = await Promise.all([
      this.#assistantSession(workspaceId, userId),
      this.computers(workspaceId, userId),
    ]);
    if (session) return { computers, assistant: session };
    // First sign-in provisions the assistant before the page loads: only a member whose
    // provisioning failed has none yet. `ensure` is idempotent and race-safe (a lost create reads
    // the winner's session), so repairing it here keeps the wizard from hiding behind a silent
    // assistant.
    await new WorkspaceAssistants(this.db).ensure(workspaceId, userId);
    const repaired = await this.#assistantSession(workspaceId, userId);
    if (!repaired) throw new AppError("INTERNAL_ERROR");
    return { computers, assistant: repaired };
  }

  async #assistantSession(workspaceId: string, userId: string) {
    const session = await this.db.workspaceAssistantSession.findUnique({
      where: this.key(workspaceId, userId),
      select: { agent: { select: { id: true, displayName: true, avatarMascot: true } } },
    });
    return session
      ? {
          agentId: session.agent.id,
          displayName: session.agent.displayName,
          avatarMascot: session.agent.avatarMascot,
        }
      : null;
  }

  /**
   * Binds the member's assistant to `choice.computerId` with the chosen runtime, while the wizard
   * is pending and the assistant has never run (`WorkspaceAssistants.configure`). Nothing is
   * started here: the Start is the wizard's last step.
   */
  async configureAssistant(workspaceId: string, userId: string, choice: AssistantRuntimeChoice) {
    if (!(await this.#pendingSince(workspaceId, userId)))
      throw new AppError("INVALID_INPUT", { errorId: "onboarding-not-pending" });
    assertProviderSelectable(choice.provider);
    // The wizard has no API-key field: CoForge's own runtime cannot be chosen here.
    if (choice.provider === RUNTIME_PROVIDER.COFORGE)
      throw new AppError("INVALID_INPUT", { errorId: "agent-api-key-required" });
    await new WorkspaceAssistants(this.db).configure(
      workspaceId,
      userId,
      {
        computerId: choice.computerId,
        runtimeConfig: agentRuntimeConfig(choice, { kind: "default" }),
      },
      () => this.ports.canRun({ workspaceId, userId, ...choice }),
    );
  }

  /**
   * Finishes (with the role) or skips (without) the wizard: saves the role, clears the mark, then
   * starts the assistant so it introduces itself. Only the call that clears the mark saves the role
   * and starts; a repeat just names the assistant's DM. Returns that DM.
   */
  async complete(workspaceId: string, userId: string, input: { role?: PersonRole }) {
    const cleared = await this.db.$transaction(async (tx) => {
      const { count } = await tx.workspaceMemberPreference.updateMany({
        where: { workspaceId, userId, onboardingPendingSince: { not: null } },
        data: { onboardingPendingSince: null },
      });
      if (count > 0 && input.role)
        await new UserPreferences(new PrismaUserPreferencesRepository(tx)).setRole(
          userId,
          input.role,
        );
      return count > 0;
    });
    if (cleared) return this.ports.startAssistant(workspaceId, userId).then(dm);
    // A repeat, or a member the wizard never covered: only a member of the Workspace asks. An
    // assistant that still has never run lost its Start after the mark was cleared, so the repeat
    // starts it (idempotent: a Start already under way is joined, a settled welcome is not sent).
    await this.#pendingSince(workspaceId, userId);
    const assistant = await new WorkspaceAssistants(this.db).ensure(workspaceId, userId);
    const neverRan = await this.db.agent.count({ where: { id: assistant.agentId, ...NEVER_RAN } });
    return neverRan > 0 ? this.ports.startAssistant(workspaceId, userId).then(dm) : dm(assistant);
  }
}

const dm = ({ conversationId }: { conversationId: string }) => ({ conversationId });

export function onboardingWizard(db: PrismaClient) {
  return new OnboardingWizard(db, {
    online: (scopes) => getComputerStatusCache().getMany(scopes),
    canRun: ({ workspaceId, userId, computerId, ...config }) =>
      computerCanRunAgent(db, { workspaceId, userId }, computerId, { ...config, hasApiKey: false }),
    startAssistant: (workspaceId, userId) =>
      workspaceAssistantOnboarding(db).ensure(workspaceId, userId, { startIfOwed: true }),
  });
}

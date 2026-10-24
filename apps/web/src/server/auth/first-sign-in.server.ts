import { workspaceAssistantOnboarding } from "#src/server/agents/workspace-assistant-onboarding.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  PrismaFirstSignInNames,
  withFirstSignInUser,
} from "#src/server/db/repositories/first-sign-in.repositories.server";
import { namePrefill } from "#src/features/auth/name-prefill";
import { checkPersonName, type PersonNameProblem } from "#src/features/profiles/person-name";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { isWorkspaceSlugFree } from "#src/server/db/repositories/workspace-slugs.repositories.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { ensureWeeklyReportAssistant } from "#src/server/records/weekly-report-assistant.server";
import {
  PrismaWorkspaceEnrollmentStore,
  WorkspaceEnrollment,
  provisionWorkspaceEnrollment,
} from "#src/server/workspaces/enrollment.server";
import {
  defaultCloudComputerId,
  startDefaultCloudComputer,
} from "#src/server/workspaces/create-workspace.server";

export type FirstSignInInput = {
  user: { id: string; username: string };
  displayName: string;
  workspaceSlug?: string;
  acceptLanguage: string;
};

export type ConfirmedEnrollment = {
  workspaceId: string;
  displayName: string;
  ownsWorkspace: boolean;
};

/** Name confirmation and initial enrollment must commit together, serialized per User. */
export type FirstSignInStore = {
  lookup(userId: string): Promise<{ displayName: string | null } | null>;
  enroll(input: FirstSignInInput): Promise<ConfirmedEnrollment>;
};

export type NameStep =
  | { status: "named" }
  /** `prefill` starts the name field, `slugPrefill` the Workspace URL field; either may be empty. */
  | { status: "ask"; prefill: string; slugPrefill: string }
  /** The session's user is gone: the person has to sign in again. */
  | { status: "account_gone" };

/** Why the personal Workspace's URL was not accepted. */
export type WorkspaceSlugProblem = "slug_invalid" | "slug_taken";

export type FirstSignInResult =
  | { ok: true; workspaceId: string }
  | { ok: false; problem: PersonNameProblem | WorkspaceSlugProblem };

/** The username as a Workspace URL to start from, or "" when it is only the fallback name (`user`,
 * `user-2`, `user-<hex>`: a sign-in that told us nothing to name the person by) or not usable. */
function workspaceSlugPrefill(username: string): string {
  const slug = nameToWorkspaceSlug(username);
  if (/^user(?:-[0-9a-f]+)?$/.test(slug)) return "";
  return isValidWorkspaceSlug(slug) && !isReservedWorkspaceSlug(slug) ? slug : "";
}

export type CloudComputerStart = (input: {
  userId: string;
  workspaceId: string;
  now: Date;
  /** The confirmed nickname, already committed before cloud provisioning starts. */
  displayName?: string;
}) => Promise<unknown>;

export type WeeklyReportAssistantBind = (input: {
  userId: string;
  workspaceId: string;
  computerId: string;
}) => Promise<unknown>;

/**
 * The step of first sign-in that asks a person for their display name and their personal
 * Workspace's URL: what the page needs to know (`readNameStep`) and what submitting it does
 * (`complete`): the Workspace is made at that URL, titled with the name, the default cloud
 * computer is started for it, the weekly-report assistant is bound to that default
 * computer. The name and Workspace commit before those resources start. Sign-in itself finishes
 * without either; a person without a name is sent here before anything is created for them.
 */
export class FirstSignIn {
  constructor(
    private readonly store: FirstSignInStore,
    private readonly startCloudComputer?: CloudComputerStart,
    private readonly bindWeeklyReportAssistant?: WeeklyReportAssistantBind,
    private readonly provisionWorkspace?: (input: {
      userId: string;
      workspaceId: string;
    }) => Promise<void>,
  ) {}

  /** Whether to ask at all, and what the fields start with: the provider's own name, when it reads
   * as one, and the username as a URL, when it is more than the fallback. */
  async readNameStep(user: { id: string; name: string; username: string }): Promise<NameStep> {
    const person = await this.store.lookup(user.id);
    if (!person) return { status: "account_gone" };
    if (person.displayName !== null) return { status: "named" };
    return {
      status: "ask",
      prefill: namePrefill(user.name),
      slugPrefill: workspaceSlugPrefill(user.username),
    };
  }

  /**
   * Commits the personal Workspace at `workspaceSlug` (from the username when absent) and its
   * display name atomically: a URL that turns out taken leaves the person unnamed, so the page
   * still asks and they can choose another. Idempotent: the first name saved stays (a second tab's,
   * or a repeated submit, cannot replace it or retitle anything), and someone who already has
   * memberships gets them back as they are. `problem` says why a name or URL was not accepted;
   * nothing is saved or created then.
   */
  async complete(input: FirstSignInInput): Promise<FirstSignInResult> {
    const checked = checkPersonName(input.displayName);
    if (!checked.ok) return { ok: false, problem: checked.problem };
    const slug = input.workspaceSlug?.trim();
    if (slug !== undefined && (!isValidWorkspaceSlug(slug) || isReservedWorkspaceSlug(slug)))
      return { ok: false, problem: "slug_invalid" };
    let enrolled: ConfirmedEnrollment;
    try {
      enrolled = await this.store.enroll({
        ...input,
        displayName: checked.name,
        workspaceSlug: slug,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, problem: "slug_taken" };
      throw error;
    }
    const { workspaceId, displayName } = enrolled;
    // These retries repair external resources after the accepted name/Workspace has committed.
    if (enrolled.ownsWorkspace)
      await this.provisionWorkspace?.({ userId: input.user.id, workspaceId });
    const started = await this.startCloudComputer?.({
      userId: input.user.id,
      workspaceId,
      now: new Date(),
      displayName,
    });
    const computerId = defaultCloudComputerId(started);
    if (computerId)
      await this.bindWeeklyReportAssistant?.({
        userId: input.user.id,
        workspaceId,
        computerId,
      });
    return { ok: true, workspaceId };
  }
}

class PrismaFirstSignInStore implements FirstSignInStore {
  constructor(private readonly db: PrismaClient) {}

  lookup(userId: string) {
    return new PrismaFirstSignInNames(this.db).lookup(userId);
  }

  enroll(input: FirstSignInInput) {
    return withFirstSignInUser(this.db, input.user.id, async (tx) => {
      const names = new PrismaFirstSignInNames(tx);
      const person = await names.lookup(input.user.id);
      const title = person?.displayName ?? input.displayName;
      const { workspaceId } = await new WorkspaceEnrollment(
        new PrismaWorkspaceEnrollmentStore(tx),
      ).ensureForUser(
        { ...input.user, displayName: title },
        input.acceptLanguage,
        input.workspaceSlug,
      );
      const displayName = await names.confirm(input.user.id, title);
      return {
        workspaceId,
        displayName,
        ownsWorkspace: await names.ownsWorkspace(input.user.id, workspaceId),
      };
    });
  }
}

function firstSignIn(db: PrismaClient): FirstSignIn {
  return new FirstSignIn(
    new PrismaFirstSignInStore(db),
    (request) =>
      startDefaultCloudComputer(
        (input) => productionCloudComputers(db).ensureDefault(input),
        request,
      ),
    async (request) => {
      await workspaceAssistantOnboarding(db).ensure(request.workspaceId, request.userId);
      return ensureWeeklyReportAssistant(db, request);
    },
    ({ workspaceId, userId }) => provisionWorkspaceEnrollment(db, workspaceId, userId),
  );
}

export function readNameStep(input: {
  db: PrismaClient;
  user: { id: string; name: string; username: string };
}): Promise<NameStep> {
  return firstSignIn(input.db).readNameStep(input.user);
}

export function completeFirstSignIn(input: {
  db: PrismaClient;
  user: { id: string; username: string };
  displayName: string;
  workspaceSlug?: string;
  acceptLanguage: string;
}): Promise<FirstSignInResult> {
  return firstSignIn(input.db).complete(input);
}

/** Whether a well-formed, unreserved `slug` is free for a new Workspace, as the page types it. */
export async function workspaceSlugAvailable(input: {
  db: PrismaClient;
  slug: string;
}): Promise<{ available: boolean }> {
  const slug = input.slug.trim();
  if (!isValidWorkspaceSlug(slug) || isReservedWorkspaceSlug(slug)) return { available: false };
  return { available: await isWorkspaceSlugFree(input.db, slug) };
}

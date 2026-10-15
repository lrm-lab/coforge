import type { PrismaClient } from "#src/generated/prisma/client";
import { namePrefill } from "#src/features/auth/name-prefill";
import { checkPersonName, type PersonNameProblem } from "#src/features/profiles/person-name";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { isWorkspaceSlugFree } from "#src/server/db/repositories/workspace-slugs.repositories.server";
import {
  PrismaWorkspaceEnrollmentStore,
  WorkspaceEnrollment,
} from "#src/server/workspaces/enrollment.server";

/** Where a person's display name lives. */
export type FirstSignInNames = {
  /** The name the person confirmed at first sign-in (null until they have), or null when there is
   * no such person: a session can outlive its user. */
  lookup(userId: string): Promise<{ displayName: string | null } | null>;
  /** Stores `displayName` and marks first sign-in done, unless it already is; resolves with the
   * name stored after. */
  setDisplayNameOnce(userId: string, displayName: string): Promise<string>;
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

/**
 * The step of first sign-in that asks a person for their display name and their personal
 * Workspace's URL: what the page needs to know (`readNameStep`) and what submitting it does
 * (`complete`): the Workspace is made at that URL, titled with the name, and the name is saved. Sign-in itself finishes without either; a person without a
 * name is sent here before anything is created for them.
 */
export class FirstSignIn {
  constructor(
    private readonly names: FirstSignInNames,
    private readonly enrollment: WorkspaceEnrollment,
  ) {}

  /** Whether to ask at all, and what the fields start with: the provider's own name, when it reads
   * as one, and the username as a URL, when it is more than the fallback. */
  async readNameStep(user: { id: string; name: string; username: string }): Promise<NameStep> {
    const person = await this.names.lookup(user.id);
    if (!person) return { status: "account_gone" };
    if (person.displayName !== null) return { status: "named" };
    return {
      status: "ask",
      prefill: namePrefill(user.name),
      slugPrefill: workspaceSlugPrefill(user.username),
    };
  }

  /**
   * Makes the personal Workspace at `workspaceSlug` (from the username when absent) and saves the
   * display name, in that order: a URL that turns out taken leaves the person unnamed, so the page
   * still asks and they can choose another. Idempotent: the first name saved stays (a second tab's,
   * or a repeated submit, cannot replace it or retitle anything), and someone who already has
   * memberships gets them back as they are. `problem` says why a name or URL was not accepted;
   * nothing is saved or created then.
   */
  async complete(input: {
    user: { id: string; username: string };
    displayName: string;
    workspaceSlug?: string;
    acceptLanguage: string;
  }): Promise<FirstSignInResult> {
    const checked = checkPersonName(input.displayName);
    if (!checked.ok) return { ok: false, problem: checked.problem };
    const slug = input.workspaceSlug?.trim();
    if (slug !== undefined && (!isValidWorkspaceSlug(slug) || isReservedWorkspaceSlug(slug)))
      return { ok: false, problem: "slug_invalid" };
    // A name stored before (another tab) titles the Workspace; it is the one that stays.
    const person = await this.names.lookup(input.user.id);
    const title = person?.displayName ?? checked.name;
    let workspaceId: string;
    try {
      ({ workspaceId } = await this.enrollment.ensureForUser(
        { id: input.user.id, username: input.user.username, displayName: title },
        input.acceptLanguage,
        slug,
      ));
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, problem: "slug_taken" };
      throw error;
    }
    await this.names.setDisplayNameOnce(input.user.id, checked.name);
    return { ok: true, workspaceId };
  }
}

class PrismaFirstSignInNames implements FirstSignInNames {
  constructor(private readonly db: PrismaClient) {}

  async lookup(userId: string) {
    const row = await this.db.user.findUnique({
      where: { id: userId },
      select: { displayName: true, welcomedAt: true },
    });
    // Every account has a name; it counts as confirmed once first sign-in is done.
    return row && { displayName: row.welcomedAt ? row.displayName : null };
  }

  async setDisplayNameOnce(userId: string, displayName: string) {
    // One statement decides who was first, so two tabs cannot each believe theirs was saved.
    const { count } = await this.db.user.updateMany({
      where: { id: userId, welcomedAt: null },
      data: { displayName, welcomedAt: new Date() },
    });
    if (count === 1) return displayName;
    const row = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { displayName: true },
    });
    return row.displayName;
  }
}

function firstSignIn(db: PrismaClient): FirstSignIn {
  return new FirstSignIn(
    new PrismaFirstSignInNames(db),
    new WorkspaceEnrollment(new PrismaWorkspaceEnrollmentStore(db)),
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

import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  WHATS_NEW_ENTRIES,
  pendingWhatsNew,
  recentWhatsNew,
  type WhatsNewEntryData,
} from "#src/features/whats-new/whats-new-entries";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments, type ExperimentKey } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { isDevSkipAuthEnabled } from "#src/server/auth/dev-skip-auth.server";

/**
 * "What's new"'s reads and writes (tasks #493, #516). What a person dismissed is stored on
 * their preferences, so it follows them to every device; which experiments are on is the
 * Workspace's.
 */
export class WhatsNew {
  constructor(
    private readonly db: PrismaClient,
    private readonly entries: readonly WhatsNewEntryData[] = WHATS_NEW_ENTRIES,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The ids still to show this person in this Workspace, oldest first. */
  async pending(userId: string, workspaceId: string): Promise<string[]> {
    return (await this.read(userId, workspaceId)).ids;
  }

  /**
   * What the sidebar's "What's new" needs (task #516): the entries still to show this person,
   * oldest first, and the latest released ones, newest first, for when nothing is waiting.
   */
  async read(userId: string, workspaceId: string): Promise<{ ids: string[]; recent: string[] }> {
    const [user, workspace] = await Promise.all([
      this.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          createdAt: true,
          preferences: { select: { whatsNewDismissed: true } },
        },
      }),
      this.db.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { slug: true },
      }),
    ]);
    const needed = [
      ...new Set(this.entries.flatMap((entry) => (entry.experiment ? [entry.experiment] : []))),
    ];
    const experiments = new Experiments(new PrismaExperimentsRepository(this.db), isFeatureEnabled);
    const on = new Set<ExperimentKey>();
    for (const key of needed) {
      if (
        await experiments.enabled(key, {
          workspaceId,
          workspaceSlug: workspace.slug,
        })
      ) {
        on.add(key);
      }
    }
    const now = this.now();
    const experimentOn = (key: ExperimentKey) => on.has(key);
    return {
      ids: pendingWhatsNew(this.entries, {
        now,
        joinedAt: user.createdAt,
        dismissed: user.preferences?.whatsNewDismissed ?? [],
        experimentOn,
      }),
      recent: recentWhatsNew(this.entries, { now, experimentOn }),
    };
  }

  /** "Got it" or closing the dialog: these entries are seen, on every device. */
  async dismiss(userId: string, ...ids: string[]): Promise<void> {
    // Only entries this server serves can be dismissed; the ids are not free text.
    if (!ids.every((id) => this.entries.some((entry) => entry.id === id))) {
      throw new AppError("INVALID_INPUT");
    }
    const stored = await this.db.userPreference.findUnique({
      where: { userId },
      select: { whatsNewDismissed: true },
    });
    const dismissed = stored?.whatsNewDismissed ?? [];
    const added = [...new Set(ids)].filter((id) => !dismissed.includes(id));
    if (added.length === 0) return;
    await this.db.userPreference.upsert({
      where: { userId },
      create: { userId, whatsNewDismissed: added },
      update: { whatsNewDismissed: { push: added } },
    });
  }
}

/**
 * The time entries are judged against. A browser E2E may set `COFORGE_E2E_WHATS_NEW_NOW` to see
 * entries before their release; it is honoured only where the dev sign-in bypass is, never in
 * production.
 */
export function whatsNewClock(env: NodeJS.ProcessEnv = process.env): () => Date {
  const pinned = env.COFORGE_E2E_WHATS_NEW_NOW;
  if (pinned && isDevSkipAuthEnabled(env)) {
    const at = new Date(pinned);
    if (!Number.isNaN(at.getTime())) return () => at;
  }
  return () => new Date();
}

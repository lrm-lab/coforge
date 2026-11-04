import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  WHATS_NEW_ENTRIES,
  pendingWhatsNew,
  type WhatsNewEntryData,
} from "#src/features/whats-new/whats-new-entries";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments, type ExperimentKey } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { isDevSkipAuthEnabled } from "#src/server/auth/dev-skip-auth.server";

/**
 * The "What's new" card's reads and writes (task #493). What a person dismissed is stored on
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
    return pendingWhatsNew(this.entries, {
      now: this.now(),
      joinedAt: user.createdAt,
      dismissed: user.preferences?.whatsNewDismissed ?? [],
      experimentOn: (key) => on.has(key),
    });
  }

  /** "Got it" or the close button: this entry is seen, on every device. */
  async dismiss(userId: string, id: string): Promise<void> {
    // Only an entry this server serves can be dismissed; the ids are not free text.
    if (!this.entries.some((entry) => entry.id === id)) throw new AppError("INVALID_INPUT");
    const stored = await this.db.userPreference.findUnique({
      where: { userId },
      select: { whatsNewDismissed: true },
    });
    const dismissed = stored?.whatsNewDismissed ?? [];
    if (dismissed.includes(id)) return;
    await this.db.userPreference.upsert({
      where: { userId },
      create: { userId, whatsNewDismissed: [id] },
      update: { whatsNewDismissed: [...dismissed, id] },
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

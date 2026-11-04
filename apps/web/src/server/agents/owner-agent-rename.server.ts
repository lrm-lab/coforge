import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AGENT_DISPLAY_NAME_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import type { Locale } from "#src/paraglide/runtime";
import { recordAgentProfileUpdated } from "#src/server/app-notifications/agent-events.server";
import {
  WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
  weeklyReportAssistantDisplayName,
} from "#src/server/records/weekly-report-assistant.server";
import { ownerAgentLanguage, ownerAgentName, ownerNameForAgent } from "./owner-agent-name.server";

/**
 * Keeping owner-named assistants in step with their owner (task #495). The personal assistant
 * (「X的助手」/"X's Assistant") and the weekly-report assistant (「X的周报助手」/"X's Weekly
 * Report Assistant") are named from the owner's label and interface language (`ownerAgentName`).
 * They used to drift until someone opened the Members page, which recomputed and restored the
 * name on read; now the owner's own change of name or language renames them, in the same
 * transaction.
 *
 * A hand-chosen name is left alone: a rename applies only when the stored name is still an
 * auto-name the owner's previous label produced — recognised by value (no stored flag), in
 * either language, plus the pre-#495 weekly-report name (Chinese only, cut with `String#slice`)
 * and the bare generic names. The write is a compare-and-swap on that stored name, so a
 * concurrent rename or a hand edit between the read and the write is never overwritten.
 */

const PERSONAL_SUFFIX = { "zh-CN": "的助手", en: "'s Assistant" } as const;
/** The personal assistant's name when its owner has none, by language. */
export const PERSONAL_GENERIC = { "zh-CN": "助手", en: "Assistant" } as const;
const OLD_WEEKLY_REPORT_SUFFIX = "的周报助手";
const LOCALES: readonly Locale[] = ["zh-CN", "en"];
export type OwnerAgentKind = "personal" | "weekly-report";

/** The owner's current naming: the raw display name (empty when the owner has none — never the
 * `Unnamed` placeholder, so a nameless owner keeps the generic assistant name), and the language
 * the assistants are named in. */
export type OwnerNaming = { label: string; language: Locale };

/** The personal assistant's auto-name. A nameless owner keeps the generic 通用助手 / Assistant,
 * so a blank name is never rendered as `的助手` / `'s Assistant` with nothing before it. */
export function personalAssistantAutoName({ label, language }: OwnerNaming): string {
  const person = label.trim();
  if (person.length === 0) return PERSONAL_GENERIC[language === "zh-CN" ? "zh-CN" : "en"];
  return ownerAgentName(person, PERSONAL_SUFFIX[language === "zh-CN" ? "zh-CN" : "en"]);
}

/** The weekly-report assistant's auto-name; a nameless owner keeps the generic 周报助手 /
 * Weekly Report Assistant (`weeklyReportAssistantDisplayName`). */
export function weeklyReportAutoName({ label, language }: OwnerNaming): string {
  return weeklyReportAssistantDisplayName(label, language);
}

/** The pre-#495 weekly-report auto-name: Chinese only, the label cut with `String#slice` (which
 * could split a surrogate pair). Recognised so neither the backfill nor the live rename mistakes
 * an old auto-name for a hand-chosen one. */
export function oldWeeklyReportAutoName(label: string): string {
  const person = label.trim();
  if (person.length === 0) return WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME;
  const room = AGENT_DISPLAY_NAME_MAX_LENGTH - OLD_WEEKLY_REPORT_SUFFIX.length;
  const fitted = person.length > room ? person.slice(0, room).trimEnd() : person;
  if (fitted.length === 0) return WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME;
  return `${fitted}${OLD_WEEKLY_REPORT_SUFFIX}`;
}

/**
 * Every name that counts as an auto-name for `label` — so a stored name equal to any of them is
 * one nobody has chosen by hand. Both languages (a user who never saved a language was named in
 * the request's locale, so English and Chinese both count), the pre-#495 weekly-report rule, and
 * the bare generic name an older assistant may still carry. For a nameless owner the legacy
 * placeholder names (`humanLabel`'s `Unnamed` built into a name before this fix) count too, so
 * the backfill and a rename restore them to the generic instead of taking them for hand-chosen.
 */
function autoNameCandidates(label: string, kind: OwnerAgentKind): ReadonlySet<string> {
  const nameless = label.trim().length === 0;
  if (kind === "personal")
    return new Set([
      ...LOCALES.map((language) => personalAssistantAutoName({ label, language })),
      ...(nameless
        ? LOCALES.map((language) =>
            ownerAgentName(
              UNNAMED_PERSON_NAME,
              PERSONAL_SUFFIX[language === "zh-CN" ? "zh-CN" : "en"],
            ),
          )
        : []),
    ]);
  return new Set<string>([
    ...LOCALES.map((language) => weeklyReportAutoName({ label, language })),
    oldWeeklyReportAutoName(label),
    WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
    ...(nameless
      ? [
          ...LOCALES.map((language) =>
            weeklyReportAssistantDisplayName(UNNAMED_PERSON_NAME, language),
          ),
          oldWeeklyReportAutoName(UNNAMED_PERSON_NAME),
        ]
      : []),
  ]);
}

const autoName = (naming: OwnerNaming, kind: OwnerAgentKind) =>
  kind === "personal" ? personalAssistantAutoName(naming) : weeklyReportAutoName(naming);

/** The owner's naming from a user row: the display name (`ownerNameForAgent`: trimmed, empty
 * when the owner has none, including a stored literal `Unnamed`), and the language. */
export function ownerNamingOf(user: {
  displayName: string | null;
  preferences?: { language: string | null } | null;
}): OwnerNaming {
  return {
    label: ownerNameForAgent(user.displayName),
    language: ownerAgentLanguage(user.preferences?.language),
  };
}

const OWNER_NAMING_SELECT = {
  username: true,
  displayName: true,
  preferences: { select: { language: true } },
} as const;

/** One owner-named assistant to consider: its id, Workspace, stored name, and naming rule. */
type OwnedAssistant = {
  id: string;
  workspaceId: string;
  displayName: string;
  kind: OwnerAgentKind;
};

/**
 * Renames the owner's assistants after a change to their name or language, in the caller's
 * transaction. `previous` is the owner's label and language before the change (the user row is
 * already updated). An assistant is renamed only when its stored name is still an auto-name the
 * previous label produced (in either language, or the old rule) — a hand-chosen name is left
 * alone — and the write is a compare-and-swap on that stored name. A missing user renames
 * nothing (the caller has already settled its own NOT_FOUND).
 */
export async function renameOwnerAgents(
  tx: Prisma.TransactionClient,
  userId: string,
  previous: OwnerNaming,
): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: OWNER_NAMING_SELECT });
  if (!user) return;
  const current = ownerNamingOf(user);
  const wasAuto = {
    personal: autoNameCandidates(previous.label, "personal"),
    "weekly-report": autoNameCandidates(previous.label, "weekly-report"),
  };
  for (const assistant of await ownedAssistants(tx, userId)) {
    const next = autoName(current, assistant.kind);
    if (assistant.displayName === next) continue;
    if (!wasAuto[assistant.kind].has(assistant.displayName)) continue;
    await applyRename(tx, assistant, next, { notify: true });
  }
}

/** The user's live personal and weekly-report assistants in Workspaces they are still an active
 * member of (a left Workspace's assistant is not theirs to rename), with their stored names. */
async function ownedAssistants(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<OwnedAssistant[]> {
  const liveAgent = {
    select: { id: true, displayName: true, workspaceId: true, deletedAt: true },
  } as const;
  // Still a member of the Workspace (membership is a row, removed on leave), so an assistant in a
  // Workspace the owner has left is not renamed.
  const inWorkspace = { members: { some: { userId } } };
  const [personalSessions, weeklyReports] = await Promise.all([
    tx.workspaceAssistantSession.findMany({
      where: { userId, assistant: { workspace: inWorkspace } },
      select: { agent: liveAgent },
    }),
    tx.weeklyReportAssistant.findMany({
      where: { userId, workspace: inWorkspace },
      select: { agent: liveAgent },
    }),
  ]);
  return [...ownedOf(personalSessions, "personal"), ...ownedOf(weeklyReports, "weekly-report")];
}

function ownedOf(
  rows: {
    agent: { id: string; displayName: string; workspaceId: string; deletedAt: Date | null } | null;
  }[],
  kind: OwnerAgentKind,
): OwnedAssistant[] {
  return rows.flatMap((row) =>
    row.agent && row.agent.deletedAt === null
      ? [
          {
            id: row.agent.id,
            workspaceId: row.agent.workspaceId,
            displayName: row.agent.displayName,
            kind,
          },
        ]
      : [],
  );
}

/**
 * Compare-and-swap the assistant's display name: the write only lands while the stored name is
 * still the one just read, so a concurrent rename or a hand edit in between is never overwritten.
 * `notify` records `agent.profile_updated` for installed apps when the write wins — on for a live
 * rename, off for the backfill so it does not push a batch of events to third-party apps.
 */
async function applyRename(
  tx: Prisma.TransactionClient,
  assistant: { id: string; workspaceId: string; displayName: string },
  next: string,
  options: { notify: boolean },
): Promise<boolean> {
  const { count } = await tx.agent.updateMany({
    where: { id: assistant.id, displayName: assistant.displayName },
    data: { displayName: next },
  });
  if (count === 0) return false;
  if (options.notify)
    await recordAgentProfileUpdated(tx, assistant.workspaceId, assistant.id, ["display_name"]);
  return true;
}

export type OwnerAgentBackfillSummary = {
  scanned: number;
  renamed: number;
  samples: {
    agentId: string;
    from: string;
    to: string;
    kind: OwnerAgentKind;
    /** The owner's stored display name exactly as in the database (null when unset) — dry-run
     * only, so an operator can see why a name was chosen; never logged by an apply. */
    ownerDisplayName?: string | null;
  }[];
};

const BACKFILL_BATCH = 500;

/**
 * The one-time backfill for task #495: every owner-named assistant whose stored name is an
 * auto-name — the current rule's in any language, the pre-#495 weekly-report rule's, or the bare
 * generic name — is rewritten to the current rule's name for its owner's current label and
 * language. A hand-chosen name is left alone. Needed because the Members page no longer renames
 * on read, so a stale stored name would otherwise never catch up. Batched by id (500), each write
 * a compare-and-swap, and `agent.profile_updated` is not recorded (the one-time sweep must not
 * push a batch of events to third-party apps). `dryRun` writes nothing and reports what it would
 * change.
 */
export async function backfillOwnerAgentNames(input: {
  db: PrismaClient;
  dryRun: boolean;
  sampleLimit?: number;
}): Promise<OwnerAgentBackfillSummary> {
  const { db, dryRun } = input;
  const sampleLimit = input.sampleLimit ?? 20;
  const summary: OwnerAgentBackfillSummary = { scanned: 0, renamed: 0, samples: [] };
  let after: string | undefined;
  for (;;) {
    const batch = await ownedAssistantsWithOwner(db, after, BACKFILL_BATCH);
    if (batch.length === 0) break;
    after = batch.at(-1)!.id;
    for (const candidate of batch) {
      summary.scanned += 1;
      const naming = ownerNamingOf(candidate.owner);
      const next = autoName(naming, candidate.kind);
      if (candidate.displayName === next) continue;
      if (!autoNameCandidates(naming.label, candidate.kind).has(candidate.displayName)) continue;
      summary.renamed += 1;
      if (summary.samples.length < sampleLimit)
        summary.samples.push({
          agentId: candidate.id,
          from: candidate.displayName,
          to: next,
          kind: candidate.kind,
          ...(dryRun ? { ownerDisplayName: candidate.owner.displayName } : {}),
        });
      if (!dryRun)
        await db.$transaction((tx) =>
          applyRename(tx, candidate, next, { notify: false }).then(() => undefined),
        );
    }
    if (batch.length < BACKFILL_BATCH) break;
  }
  return summary;
}

type OwnerNamingRow = {
  username: string;
  displayName: string | null;
  preferences?: { language: string | null } | null;
};

/** A page of live owner-named assistants across the deployment, ordered by agent id, after
 * `after`, with each owner's naming row. */
async function ownedAssistantsWithOwner(
  db: PrismaClient,
  after: string | undefined,
  take: number,
): Promise<(OwnedAssistant & { owner: OwnerNamingRow })[]> {
  const where = {
    deletedAt: null,
    ...(after ? { id: { gt: after } } : {}),
    OR: [
      { workspaceAssistantSession: { isNot: null } },
      { weeklyReportAssistant: { isNot: null } },
    ],
  } satisfies Prisma.AgentWhereInput;
  const rows = await db.agent.findMany({
    where,
    orderBy: { id: "asc" },
    take,
    select: {
      id: true,
      workspaceId: true,
      displayName: true,
      owner: { select: OWNER_NAMING_SELECT },
      workspaceAssistantSession: { select: { id: true } },
      weeklyReportAssistant: { select: { id: true } },
    },
  });
  return rows.flatMap((row) => {
    const kind: OwnerAgentKind | null = row.weeklyReportAssistant
      ? "weekly-report"
      : row.workspaceAssistantSession
        ? "personal"
        : null;
    return kind && row.owner
      ? [
          {
            id: row.id,
            workspaceId: row.workspaceId,
            displayName: row.displayName,
            kind,
            owner: row.owner,
          },
        ]
      : [];
  });
}

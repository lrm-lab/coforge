import type { PrismaClient } from "#src/generated/prisma/client";
import { e164Phone } from "#src/features/auth/code-destination";

/**
 * Platform operators: the people who review Marketplace apps. The role belongs to a person, not to
 * a Workspace membership (`platform_operators`), and is matched by an address the identity
 * provider vouches for: an email or a phone number. A verified address is the whole security
 * boundary here — an unverified one is something anyone can type into their own account, so it
 * never matches.
 */

/** One configured operator: an email, or a phone number in E.164. */
export type OperatorEntry = { kind: "email"; value: string } | { kind: "phone"; value: string };

/** The value a deployment configures, as one entry, or null when it is neither an email nor a
 * number this platform can use. */
export function parseOperatorEntry(input: string): OperatorEntry | null {
  const typed = input.trim();
  if (!typed) return null;
  const phone = e164Phone(typed);
  if (phone) return { kind: "phone", value: phone };
  if (!typed.includes("@")) return null;
  const email = typed.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
    ? { kind: "email", value: email }
    : null;
}

/** `COFORGE_PLATFORM_OPERATORS` split into what can be matched and what cannot. The caller logs
 * the entries it could not read; nothing here throws, so a typo never keeps the Web from booting. */
export function parseOperatorEntries(raw: string | undefined): {
  entries: OperatorEntry[];
  invalid: string[];
} {
  const entries: OperatorEntry[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    if (!part.trim()) continue;
    const entry = parseOperatorEntry(part);
    if (entry) entries.push(entry);
    else invalid.push(part.trim());
  }
  return { entries, invalid };
}

/** The person an entry names: exactly one account whose provider-verified address matches it.
 * `no-user` and `ambiguous` are answers, not errors: the operator list may name someone who has
 * not signed up yet, and an email is not unique. */
export async function findOperatorUser(
  db: Pick<PrismaClient, "user">,
  entry: OperatorEntry,
): Promise<
  { outcome: "found"; userId: string } | { outcome: "no-user" } | { outcome: "ambiguous" }
> {
  const users = await db.user.findMany({
    where:
      entry.kind === "email"
        ? { email: { equals: entry.value, mode: "insensitive" }, emailVerified: true }
        : { phone: entry.value, phoneVerified: true },
    select: { id: true },
    take: 2,
  });
  if (users.length === 0) return { outcome: "no-user" };
  if (users.length > 1) return { outcome: "ambiguous" };
  return { outcome: "found", userId: users[0]!.id };
}

/** Makes the one person whose sign-in email is `email` an `app_reviewer`. This is the emergency
 * path from a shell (`apps/web/scripts/grant-platform-operator.ts`); a deployment seeds the first
 * operators from `COFORGE_PLATFORM_OPERATORS` at startup instead. Idempotent, and keeps an
 * existing grant's time. An email that matches no person, or more than one, grants nothing. */
export async function grantPlatformOperator(
  db: PrismaClient,
  email: string,
): Promise<"granted" | "already" | "no-user" | "ambiguous"> {
  const entry = parseOperatorEntry(email);
  if (!entry) return "no-user";
  const match = await findOperatorUser(db, entry);
  if (match.outcome !== "found") return match.outcome;
  const existing = await db.platformOperator.findUnique({
    where: { userId: match.userId },
    select: { userId: true },
  });
  if (existing) return "already";
  await db.platformOperator.create({ data: { userId: match.userId, role: "app_reviewer" } });
  return "granted";
}

/** The advisory lock one seeding pass holds: two instances booting at once must not both decide
 * the table is empty and both grant. */
const SEED_LOCK_KEY = 7_245_001;

export type SeedOutcome = {
  /** Whether this pass looked at all: a pass over a table that already has an operator does
   * nothing, so a removed operator is never added back by the next boot. */
  seeded: boolean;
  granted: number;
  unknown: string[];
  ambiguous: string[];
};

/**
 * Grants the configured operators when there is none yet: the first deployment's way in, and the
 * only automatic one. It runs in one transaction holding an advisory lock, so several instances
 * starting together seed once, and it never removes or re-adds anybody afterwards.
 */
export async function seedPlatformOperators(
  db: PrismaClient,
  raw: string | undefined,
  log: (message: string, detail?: unknown) => void,
): Promise<SeedOutcome> {
  const { entries, invalid } = parseOperatorEntries(raw);
  for (const entry of invalid)
    log("COFORGE_PLATFORM_OPERATORS has an entry that is neither an email nor a phone number", {
      entry,
    });
  const outcome: SeedOutcome = { seeded: false, granted: 0, unknown: [], ambiguous: [] };
  if (entries.length === 0) return outcome;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`;
    if ((await tx.platformOperator.count()) > 0) return;
    outcome.seeded = true;
    for (const entry of entries) {
      const match = await findOperatorUser(tx, entry);
      if (match.outcome === "ambiguous") outcome.ambiguous.push(entry.value);
      else if (match.outcome === "no-user") outcome.unknown.push(entry.value);
      else {
        const created = await tx.platformOperator.createMany({
          data: [{ userId: match.userId, role: "app_reviewer" }],
          skipDuplicates: true,
        });
        outcome.granted += created.count;
      }
    }
  });
  return outcome;
}

/** One operator as the review page lists them. */
export type PlatformOperatorRow = {
  userId: string;
  name: string;
  email: string | null;
  /** `null` when the provider has not said whether it verified the address. */
  emailVerified: boolean | null;
  phone: string | null;
  phoneVerified: boolean | null;
  grantedAt: string;
  /** The operator who granted it; null for the first one, seeded by the deployment. */
  grantedByName: string | null;
};

/** Who may change the operator list: an operator already on it. */
export class PlatformOperators {
  constructor(private readonly db: PrismaClient) {}

  private isReviewer(userId: string) {
    return this.db.platformOperator
      .findUnique({ where: { userId }, select: { role: true } })
      .then((row) => row?.role === "app_reviewer");
  }

  /** Every operator, for an operator; undefined for anyone else. */
  async list(actorUserId: string): Promise<PlatformOperatorRow[] | undefined> {
    if (!(await this.isReviewer(actorUserId))) return undefined;
    const rows = await this.db.platformOperator.findMany({
      orderBy: { grantedAt: "asc" },
      select: {
        grantedAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            emailVerified: true,
            phone: true,
            phoneVerified: true,
          },
        },
        grantedBy: { select: { displayName: true } },
      },
    });
    return rows.map((row) => ({
      userId: row.user.id,
      name: row.user.displayName,
      email: row.user.email,
      emailVerified: row.user.emailVerified,
      phone: row.user.phone,
      phoneVerified: row.user.phoneVerified,
      grantedAt: row.grantedAt.toISOString(),
      grantedByName: row.grantedBy?.displayName ?? null,
    }));
  }

  /** Grants the operator `entry` names, recording who did it. A refusal says why the page could
   * not do it, and never leaks whether an unverified address exists on some account. */
  async grant(
    actorUserId: string,
    entry: OperatorEntry,
  ): Promise<"granted" | "already" | "no_user" | "ambiguous" | "not_operator"> {
    if (!(await this.isReviewer(actorUserId))) return "not_operator";
    const match = await findOperatorUser(this.db, entry);
    if (match.outcome !== "found") return match.outcome === "no-user" ? "no_user" : "ambiguous";
    const created = await this.db.platformOperator.createMany({
      data: [{ userId: match.userId, role: "app_reviewer", grantedByUserId: actorUserId }],
      skipDuplicates: true,
    });
    return created.count > 0 ? "granted" : "already";
  }

  /** Removes an operator. The last one cannot be removed, whoever asks: without an operator no one
   * can review an app, and no one could add an operator back from the page. */
  async revoke(
    actorUserId: string,
    userId: string,
  ): Promise<"revoked" | "missing" | "last" | "not_operator"> {
    if (!(await this.isReviewer(actorUserId))) return "not_operator";
    return this.db.$transaction(async (tx) => {
      const remaining = await tx.platformOperator.count();
      const target = await tx.platformOperator.findUnique({
        where: { userId },
        select: { userId: true },
      });
      if (!target) return "missing";
      if (remaining <= 1) return "last";
      await tx.platformOperator.delete({ where: { userId } });
      return "revoked";
    });
  }
}

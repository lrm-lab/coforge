import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { nameToSlug } from "#src/lib/slug";
import { USERNAME_PATTERN } from "#src/lib/username-grammar";
import { isReservedWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

/** What a sign-in tells us about a person that can name their account. */
export type UsernameProfile = {
  preferredUsername?: string | null;
  email?: string | null;
  /** Whether the provider verified that email; absent when it did not say. Never names the account. */
  emailVerified?: boolean | null;
  /** The provider's phone number in E.164, stored on the account and never used to name it. */
  phone?: string | null;
  /** Whether the provider verified that number; absent when it did not say. Never names the account. */
  phoneVerified?: boolean | null;
  name?: string | null;
  nickname?: string | null;
};

/** Room for `-NNNNNNN` under the grammar's 32-character limit. */
const BASE_MAX_LENGTH = 24;
/** Room for `-` and 8 hex characters. */
const HEX_SUFFIXED_BASE_MAX_LENGTH = 23;
/** Times a create that lost a race is tried again with the next free name before the hex suffix. */
const COLLISION_RETRIES = 5;
const FALLBACK_BASE = "user";

/** Mailboxes whose address is the person's QQ number: `971766802@qq.com`, and the VIP and Foxmail
 * domains of the same Tencent mail service. Other `qq.com` subdomains are not (`exmail.qq.com` is
 * a company's own mail). */
const QQ_MAIL_DOMAINS = new Set(["qq.com", "vip.qq.com", "foxmail.com"]);

/** Names that would read as something other than a person in a mention or a URL. `user` is not
 * one: it is the last-resort base, and takes the same `-N` suffix as any other. */
const RESERVED_USERNAMES = new Set([
  "admin",
  "agent",
  "all",
  "channel",
  "channels",
  "coforge",
  "everyone",
  "general",
  "group",
  "groups",
  "here",
  "human",
  "me",
  "system",
  "you",
]);

/** Which of a profile's fields a base name came from. */
export type UsernameBaseSource = "preferred_username" | "email" | "name" | "nickname" | "fallback";

/**
 * The readable base name for a new account: the first of the person's `preferred_username`, the
 * local part of their email, and their name or nickname that yields a name the grammar allows,
 * else `user`. It is a pure function of the profile, so the same rule holds for every source.
 */
export function usernameBase(profile: UsernameProfile): string {
  return resolveUsernameBase(profile).base;
}

/** `usernameBase`, and which field produced it (`fallback` when none did). */
export function resolveUsernameBase(profile: UsernameProfile): {
  base: string;
  source: UsernameBaseSource;
} {
  const candidates: [UsernameBaseSource, string | undefined][] = [
    ["preferred_username", strictName(profile.preferredUsername)],
    ["email", emailName(profile.email)],
    ["name", asciiSlug(profile.name)],
    ["nickname", asciiSlug(profile.nickname)],
  ];
  for (const [source, candidate] of candidates) {
    const base = candidate && allowedBase(candidate);
    if (base) return { base, source };
  }
  return { base: FALLBACK_BASE, source: "fallback" };
}

/**
 * The readable base for a person who is confirming their display name: the name by the same rule
 * as a profile's name, with each run of Chinese characters written as pinyin (no tones, syllables
 * joined, `ü` as `v`: 安栋 is `andong`). Undefined when nothing usable results, which includes the
 * placeholder `Unnamed` and a name that comes down to the fallback `user`. Async because the pinyin
 * dictionary is large and loaded only here, on the first sign-in of a person with a Chinese name.
 */
export async function displayNameUsernameBase(displayName: string): Promise<string | undefined> {
  const name = displayName.trim();
  if (name === UNNAMED_PERSON_NAME) return undefined;
  const slug = asciiSlug(await withPinyin(name));
  const base = slug && allowedBase(slug);
  return base && base !== FALLBACK_BASE ? base : undefined;
}

/** The name with each run of Chinese characters replaced by its pinyin as one word. */
async function withPinyin(name: string): Promise<string> {
  if (!/\p{Script=Han}/u.test(name)) return name;
  const { pinyin } = await import("pinyin-pro");
  return name.replace(
    /\p{Script=Han}+/gu,
    (han) => ` ${pinyin(han, { toneType: "none", type: "array", v: true }).join("")} `,
  );
}

/** Whether a username is what the allocator gave a sign-in that told it nothing: `user`,
 * `user-<n>`, or `user-<8 hex>` (a name that lost every retry). Only these are ever renamed. */
export function isFallbackUsername(username: string): boolean {
  return FALLBACK_USERNAME.test(username);
}

const FALLBACK_USERNAME = new RegExp(`^${FALLBACK_BASE}(?:-(?:\\d+|[0-9a-f]{8}))?$`);

/**
 * Hands out the smallest free readable username and runs the caller's create with it. Uniqueness
 * is the database's: a create that loses a race on the name is tried again with the next free
 * one, so nothing is locked.
 */
export class UsernameAllocator {
  /** `takenAround` lists the stored usernames equal to `base` or starting with `base-`. */
  constructor(private readonly takenAround: (base: string) => Promise<string[]>) {}

  /**
   * Calls `create` with a free username and returns its result. `create` throws a unique
   * violation when the name was taken meanwhile; any other error is the caller's and is not
   * retried.
   */
  create<T>(profile: UsernameProfile, create: (username: string) => Promise<T>): Promise<T> {
    return this.allocate(usernameBase(profile), create);
  }

  /** `create`, from a base the caller has already settled on (a rename, say). */
  async allocate<T>(base: string, create: (username: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < COLLISION_RETRIES; attempt += 1) {
      const username = smallestFree(base, await this.takenAround(base));
      try {
        return await create(username);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const stem = base.slice(0, HEX_SUFFIXED_BASE_MAX_LENGTH).replace(/[-_]+$/, "");
    return create(`${stem}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`);
  }
}

/** The base, else `base-2`, `base-3`, ...: only these count as taken, so `ada3x` and an older
 * `ada3-d9956ab1` never block `ada3`. */
export function smallestFree(base: string, taken: readonly string[]): string {
  const numbers = new Set<number>();
  let baseTaken = false;
  for (const name of taken) {
    if (name === base) baseTaken = true;
    else if (name.startsWith(`${base}-`)) {
      const rest = name.slice(base.length + 1);
      if (/^\d+$/.test(rest)) numbers.add(Number(rest));
    }
  }
  if (!baseTaken) return base;
  let next = 2;
  while (numbers.has(next)) next += 1;
  return `${base}-${next}`;
}

/** A `preferred_username` is not rewritten into a name the way an email or a name is: it is
 * lower-cased and used only if it already looks like one. Like every source it may still get the
 * `u` prefix or a cut to 24 characters (`allowedBase`). */
function strictName(value: string | null | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

/** Lower-case, every other run of characters becomes one `-`, no separator at either end. */
function normalizedName(value: string | undefined): string | undefined {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function emailLocalPart(email: string | null | undefined): string | undefined {
  return email?.split("@", 1)[0]?.split("+", 1)[0];
}

/** The email's local part as a name; at a QQ mailbox an all-digit one is the QQ number, `qq<digits>`,
 * which the grammar can take where bare digits it cannot. */
function emailName(email: string | null | undefined): string | undefined {
  const local = emailLocalPart(email);
  const domain = email?.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (local && /^[0-9]+$/.test(local) && domain && QQ_MAIL_DOMAINS.has(domain)) return `qq${local}`;
  return normalizedName(local);
}

/** The ASCII part of a name as a slug; a name with no ASCII letters or digits yields nothing.
 * Uncut, so a phone number late in a long name is still seen (`allowedBase` cuts it). */
function asciiSlug(name: string | null | undefined): string | undefined {
  return name ? nameToSlug(name, name.length) : undefined;
}

/** A candidate that reads as a name, made to fit the grammar; undefined when it cannot be. */
function allowedBase(candidate: string): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(candidate)) return undefined;
  if (looksLikePhoneNumber(candidate)) return undefined;
  const lettered = /^[0-9]/.test(candidate) ? `u${candidate}` : candidate;
  const base = lettered.slice(0, BASE_MAX_LENGTH).replace(/[-_]+$/, "");
  return USERNAME_PATTERN.test(base) && !isReserved(base) ? base : undefined;
}

/** A run of eleven or more digits, however it is spaced or surrounded (`wx13800138000`,
 * `tel-138-0013-8000`), may be a phone number. The username is in every `@` mention and the
 * personal Workspace's slug, so such a value is never used. A candidate is already normalised, so
 * `-` and `_` are the only separators left to see through. */
function looksLikePhoneNumber(candidate: string): boolean {
  return /[0-9]{11}/.test(candidate.replace(/[-_]/g, ""));
}

function isReserved(base: string): boolean {
  return RESERVED_USERNAMES.has(base) || isReservedWorkspaceSlug(base);
}

/** The allocator over the stored usernames: the ones equal to a base or starting with `base-`. */
export function prismaUsernameAllocator(db: DatabaseScope): UsernameAllocator {
  return new UsernameAllocator(async (base) =>
    (
      await db.user.findMany({
        where: { OR: [{ username: base }, { username: { startsWith: `${base}-` } }] },
        select: { username: true },
      })
    ).map((row) => row.username),
  );
}

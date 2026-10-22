import { APP_KEY_PATTERN } from "@lrm/coforge-sdk/internal/agent-launch-apps";
import { hasControlOrBidiCharacter, isInvisibleText } from "#src/features/profiles/person-name";
import { nameToSlug } from "#src/lib/slug";
import { APP_CATEGORIES, type AppCategory } from "./app-category";

/**
 * What a Workspace may register as a third-party app, and the change it may make to one later.
 * Pure and client-safe; the app registry (`server/apps/`) enforces it.
 */

/** The longest key, name, description and when-to-use text, counted as code points. */
export const APP_KEY_MAX_LENGTH = 64;
export const APP_NAME_MAX_LENGTH = 80;
export const APP_DESCRIPTION_MAX_LENGTH = 500;
export const APP_WHEN_TO_USE_MAX_LENGTH = 160;
/** The longest URL an app may give: what browsers and proxies reliably carry through a redirect
 * (the de facto 2,048-character limit). */
export const APP_URL_MAX_LENGTH = 2048;

/** The scopes an app may be allowed to request. */
export const APP_SCOPES = ["openid", "profile", "identity", "email"] as const;
export type AppScope = (typeof APP_SCOPES)[number];
/** The scopes every app has: signing a person in, their name, and who they are in the Workspace. */
export const APP_FIXED_SCOPES = [
  "openid",
  "profile",
  "identity",
] as const satisfies readonly AppScope[];

/** The scopes Login with CoForge lets an app with `allowed` ask for: the fixed ones and any
 * optional one it is allowed, in `APP_SCOPES` order (the editor and the app detail both show it). */
export function appLoginScopes(allowed: readonly string[]): AppScope[] {
  return APP_SCOPES.filter(
    (scope) => (APP_FIXED_SCOPES as readonly string[]).includes(scope) || allowed.includes(scope),
  );
}

export const MAX_REDIRECT_URIS = 10;
/** The hosts a redirect URI may reach over plain http: a native or development client on the
 * user's own machine (RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Whitespace or a control character: the URL parser would drop or encode it, so the stored
 * string would no longer be the one a client sends. */
const UNSAFE_URI_CHARACTER = /[\s\p{Cc}]/u;

export type AppRegistrationInput = {
  key: string;
  name: string;
  description: string;
  whenToUse: string;
  /** None (`null`) or an https URL: only the name is required. */
  homepageUrl: string | null;
  redirectUris: string[];
  category: AppCategory;
  allowedScopes: string[];
};

/** A change to a registered app: any field but its key. */
export type AppPatch = Partial<Omit<AppRegistrationInput, "key">>;

/** The input field a refusal names, for a form to show the problem beside it. */
export type AppInputField = keyof AppRegistrationInput;

type AppInputCheck<Value> = { ok: true; value: Value } | { ok: false; field: AppInputField };

/** A field's rule: the value as stored, or a refusal, for any value a caller sent. */
type FieldCheck<Value> = (value: unknown) => { ok: true; value: Value } | { ok: false };

const accept = <Value>(value: Value) => ({ ok: true as const, value });
const REFUSE = { ok: false as const };

/**
 * A text people and Agents read, stored trimmed and `min` to `max` characters counted as code
 * points. Control and bidirectional characters are refused (the rule for a person's name), except
 * line breaks where `lines` allows them; a required text must not be only invisible characters.
 */
export const text =
  (min: number, max: number, { lines = false } = {}): FieldCheck<string> =>
  (value) => {
    if (typeof value !== "string") return REFUSE;
    const trimmed = value.trim();
    const length = [...trimmed].length;
    if (length < min || length > max) return REFUSE;
    if (hasControlOrBidiCharacter(lines ? trimmed.replaceAll("\n", "") : trimmed)) return REFUSE;
    if (min > 0 && isInvisibleText(trimmed)) return REFUSE;
    return accept(trimmed);
  };

/**
 * An absolute URL already in the canonical form the parser writes it in, with no user info, or
 * `undefined`. Canonical means the string is what is stored and later compared, and a reader sees
 * the host the parser does: `https:evil.example/cb`, `http://0x7f.1/cb` and `https://ACME.example/`
 * are refused rather than rewritten, and a bare origin is written with its slash
 * (`https://acme.example/`).
 */
function canonicalUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > APP_URL_MAX_LENGTH) return undefined;
  if (UNSAFE_URI_CHARACTER.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.href === value && !url.username && !url.password ? url : undefined;
}

/** An https URL, or `null` for an app with no homepage. A blank string is refused: a form sends a
 * blank field as `null`. */
const homepageUrl: FieldCheck<string | null> = (value) =>
  value === null || canonicalUrl(value)?.protocol === "https:"
    ? accept(value as string | null)
    : REFUSE;

/** Whether one redirect URI passes the rule the list applies to each of its URIs. Compared later
 * by exact string match (RFC 9700 §2.1), so only accepted as written. */
export function isRedirectUri(value: unknown): boolean {
  const url = canonicalUrl(value);
  if (!url || url.href.includes("#")) return false;
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/** None to `MAX_REDIRECT_URIS`, none twice: a repeat is a mistake, never silently merged. An app
 * with none signs no one in; its Agents can still get tokens for it. */
const redirectUris: FieldCheck<string[]> = (value) => {
  if (!Array.isArray(value) || value.length > MAX_REDIRECT_URIS) return REFUSE;
  return new Set(value).size === value.length && value.every(isRedirectUri)
    ? accept(value as string[])
    : REFUSE;
};

const allowedScopes: FieldCheck<string[]> = (value) => {
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === "string")) return REFUSE;
  const unique = [...new Set(value as string[])];
  const scopes: readonly string[] = APP_SCOPES;
  return APP_FIXED_SCOPES.every((scope) => unique.includes(scope)) &&
    unique.every((scope) => scopes.includes(scope))
    ? accept(unique)
    : REFUSE;
};

/** Every field an app's input has, each with its rule: the one list of what a caller may set. */
const FIELD_CHECKS: { [Field in AppInputField]: FieldCheck<AppRegistrationInput[Field]> } = {
  // The SDK's one key pattern (3 to `APP_KEY_MAX_LENGTH`, never dotted like a built-in app's), which
  // an Agent's launch identity checks too.
  key: (value) =>
    typeof value === "string" && APP_KEY_PATTERN.test(value) ? accept(value) : REFUSE,
  name: text(1, APP_NAME_MAX_LENGTH),
  description: text(0, APP_DESCRIPTION_MAX_LENGTH, { lines: true }),
  whenToUse: text(0, APP_WHEN_TO_USE_MAX_LENGTH),
  homepageUrl,
  redirectUris,
  category: (value) => {
    const categories: readonly unknown[] = APP_CATEGORIES;
    return categories.includes(value) ? accept(value as AppCategory) : REFUSE;
  },
  allowedScopes,
};

const FIELDS = Object.keys(FIELD_CHECKS) as AppInputField[];

/** The `errorId` the registry refuses each field with, and the form reads back. */
export const APP_INPUT_ERROR_IDS: Record<AppInputField, string> = {
  key: "app-key-invalid",
  name: "app-name-invalid",
  description: "app-description-invalid",
  whenToUse: "app-when-to-use-invalid",
  homepageUrl: "app-homepage-url-invalid",
  redirectUris: "app-redirect-uris-invalid",
  category: "app-category-invalid",
  allowedScopes: "app-allowed-scopes-invalid",
};

/** The field an `APP_INPUT_ERROR_IDS` id names, or `undefined` for any other id. */
export function appInputFieldOf(errorId: string | undefined): AppInputField | undefined {
  return FIELDS.find((field) => APP_INPUT_ERROR_IDS[field] === errorId);
}

/** Every field's rule over `input`, in field order: the values as stored, and the fields refused.
 * A field the input does not carry is refused when `requireAll`, else left out. */
function checkFields(input: Partial<Record<AppInputField, unknown>>, requireAll: boolean) {
  const value: Partial<Record<AppInputField, unknown>> = {};
  const refused: AppInputField[] = [];
  for (const field of FIELDS) {
    const given = input[field];
    if (given === undefined) {
      if (requireAll) refused.push(field);
      continue;
    }
    const outcome = FIELD_CHECKS[field](given);
    if (outcome.ok) value[field] = outcome.value;
    else refused.push(field);
  }
  return { value: value as Partial<AppRegistrationInput>, refused };
}

/**
 * The input as stored, holding only the fields `FIELD_CHECKS` names, or the first field refused.
 * A registration needs every field; a patch never carries the key and checks only the fields it
 * has.
 */
export function checkAppInput(
  input: AppRegistrationInput,
  kind: "registration",
): AppInputCheck<AppRegistrationInput>;
export function checkAppInput(input: AppPatch, kind: "patch"): AppInputCheck<AppPatch>;
export function checkAppInput(
  input: Partial<AppRegistrationInput>,
  kind: "registration" | "patch",
): AppInputCheck<Partial<AppRegistrationInput>> {
  const { value, refused } =
    kind === "registration"
      ? checkFields(input, true)
      : checkFields({ ...input, key: undefined }, false);
  const [field] = refused;
  return field ? { ok: false, field } : { ok: true, value };
}

/** Every field `input` carries that its rule refuses, in field order: what a form marks at once,
 * where `checkAppInput` stops at the first. A change leaves the key out. */
export function refusedAppFields(input: Partial<AppRegistrationInput>): AppInputField[] {
  return checkFields(input, false).refused;
}

/** A key for an app registered without one: its name as a slug, then `suffix`. A name with no
 * slug-able letters (`笔记`), or one that starts with a digit, starts with `app-` instead, so the
 * key always matches the key rule. */
export function appKeyFromName(name: string, suffix: string): string {
  const room = APP_KEY_MAX_LENGTH - suffix.length - 1;
  const slug = nameToSlug(name, room);
  const stem = /^[a-z]/.test(slug) ? slug : nameToSlug(`app-${slug}`, room);
  return `${stem}-${suffix}`;
}

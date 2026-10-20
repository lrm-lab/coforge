import { hasControlOrBidiCharacter, isInvisibleText } from "#src/features/profiles/person-name";

/**
 * What a Workspace may register as a third-party app, and the change it may make to one later.
 * Pure and client-safe; the app registry (`server/apps/`) enforces it.
 */

/** A third-party app's key, which is also its OIDC `client_id`. Never dotted, so it never names a
 * built-in app (`system.cleaner`). */
const APP_KEY = /^[a-z][a-z0-9-]{2,63}$/;

/** The scopes an app may be allowed to request; `openid` is required. */
const APP_SCOPES: readonly string[] = ["openid", "profile", "email", "workspace"];

const MAX_REDIRECT_URIS = 10;
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
  homepageUrl: string;
  redirectUris: string[];
  resourceUri: string | null;
  allowedScopes: string[];
};

/** A change to a registered app: any field but its key. */
export type AppPatch = Partial<Omit<AppRegistrationInput, "key">>;

/** The input field a refusal names, for a form to show the problem beside it. */
type AppInputField = keyof AppRegistrationInput;

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
const text =
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
  if (typeof value !== "string" || UNSAFE_URI_CHARACTER.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.href === value && !url.username && !url.password ? url : undefined;
}

const homepageUrl: FieldCheck<string> = (value) =>
  canonicalUrl(value)?.protocol === "https:" ? accept(value as string) : REFUSE;

const resourceUri: FieldCheck<string | null> = (value) => {
  if (value === null) return accept(value);
  const url = canonicalUrl(value);
  return url?.protocol === "https:" && !url.href.includes("#") ? accept(url.href) : REFUSE;
};

/** Compared later by exact string match (RFC 9700 §2.1), so only accepted as written. */
function isRedirectUri(value: unknown): boolean {
  const url = canonicalUrl(value);
  if (!url || url.href.includes("#")) return false;
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/** 1 to `MAX_REDIRECT_URIS`, none twice: a repeat is a mistake, never silently merged. */
const redirectUris: FieldCheck<string[]> = (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REDIRECT_URIS) return REFUSE;
  return new Set(value).size === value.length && value.every(isRedirectUri)
    ? accept(value as string[])
    : REFUSE;
};

const allowedScopes: FieldCheck<string[]> = (value) => {
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === "string")) return REFUSE;
  const unique = [...new Set(value as string[])];
  return unique.includes("openid") && unique.every((scope) => APP_SCOPES.includes(scope))
    ? accept(unique)
    : REFUSE;
};

/** Every field an app's input has, each with its rule: the one list of what a caller may set. */
const FIELD_CHECKS: { [Field in AppInputField]: FieldCheck<AppRegistrationInput[Field]> } = {
  key: (value) => (typeof value === "string" && APP_KEY.test(value) ? accept(value) : REFUSE),
  name: text(1, 80),
  description: text(0, 500, { lines: true }),
  whenToUse: text(0, 160),
  homepageUrl,
  redirectUris,
  resourceUri,
  allowedScopes,
};

const FIELDS = Object.keys(FIELD_CHECKS) as AppInputField[];

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
  const value: Partial<Record<AppInputField, unknown>> = {};
  for (const field of FIELDS) {
    if (kind === "patch" && field === "key") continue;
    const given: unknown = input[field];
    if (given === undefined) {
      if (kind === "registration") return { ok: false, field };
      continue;
    }
    const outcome = FIELD_CHECKS[field](given);
    if (!outcome.ok) return { ok: false, field };
    value[field] = outcome.value;
  }
  return { ok: true, value: value as Partial<AppRegistrationInput> };
}

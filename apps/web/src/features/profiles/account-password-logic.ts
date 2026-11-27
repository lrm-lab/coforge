import { isSignInCode } from "#src/features/auth/code-destination";
import { isNewPassword } from "#src/features/auth/new-password";
import { m } from "#src/paraglide/messages";

export type AccountPasswordProblem =
  | "invalid_input"
  | "failed"
  | "no_contact"
  | "identity_mismatch"
  | "rate_limited"
  | "invalid_code"
  | "password_mismatch"
  | "password_refused"
  | "send_failed"
  | "invalid_destination"
  | "invalid_bind_token"
  | "unavailable"
  | "refused"
  | "bind_failed"
  | "github_denied"
  | "github_failed";

const problemText: Record<AccountPasswordProblem, () => string> = {
  invalid_input: () => m.settings_password_problem_invalid_input(),
  failed: () => m.settings_password_problem_failed(),
  no_contact: () => m.settings_password_problem_no_contact(),
  identity_mismatch: () => m.settings_password_problem_identity_mismatch(),
  rate_limited: () => m.settings_password_problem_rate_limited(),
  invalid_code: () => m.settings_password_problem_invalid_code(),
  password_mismatch: () => m.settings_password_problem_mismatch(),
  password_refused: () => m.settings_password_problem_password_refused(),
  send_failed: () => m.settings_password_problem_send_failed(),
  invalid_destination: () => m.settings_password_problem_invalid_destination(),
  invalid_bind_token: () => m.settings_password_problem_invalid_bind_token(),
  unavailable: () => m.settings_password_problem_failed(),
  refused: () => m.settings_password_problem_invalid_code(),
  bind_failed: () => m.settings_password_problem_bind_failed(),
  github_denied: () => m.settings_password_problem_github_denied(),
  github_failed: () => m.settings_password_problem_github_failed(),
};

/** What a problem says, in the person's language. */
export function accountPasswordProblemText(problem: AccountPasswordProblem): string {
  return problemText[problem]();
}

/** The contacts a code can go to, each only when there is one that can receive it. */
export type PasswordContacts = { email?: string; phone?: string };

/** A phone number as stored (E.164) that the code can be sent to: a mainland mobile. */
const MAINLAND_E164 = /^\+861\d{10}$/;

/** The verified email, and the verified mainland mobile, of a profile, plus any just bound. */
export function passwordContacts(
  profile: {
    email: string | null;
    emailVerified: boolean | null;
    phone: string | null;
    phoneVerified: boolean | null;
  },
  bound?: PasswordContacts,
): PasswordContacts {
  const contacts: PasswordContacts = { ...bound };
  if (profile.email && profile.emailVerified === true) contacts.email ??= profile.email;
  if (profile.phone && profile.phoneVerified === true && MAINLAND_E164.test(profile.phone)) {
    contacts.phone ??= profile.phone;
  }
  return contacts;
}

export type PasswordStep = "password" | "need_contact" | "bind";

/** What the GitHub round trip came back with, when the page was opened from it. */
export type BindArrival = { ok: true } | { ok: false; problem: AccountPasswordProblem };

/** Where the dialog opens: after a bind round trip, at the bind form or at the reason it failed;
 * otherwise at the password form when a code can go somewhere, else at the ask to add a contact. */
export function passwordStart(
  contacts: PasswordContacts,
  arrival?: BindArrival,
): { step: PasswordStep; problem: AccountPasswordProblem | null } {
  if (arrival?.ok === true) return { step: "bind", problem: null };
  if (arrival) return { step: "need_contact", problem: arrival.problem };
  return { step: contacts.email || contacts.phone ? "password" : "need_contact", problem: null };
}

/** What the settings page's `?bind` and `?bindError` mean; `undefined` when the page was not
 * opened from the GitHub round trip. */
export function bindArrivalFrom(search: {
  bind?: unknown;
  bindError?: string | undefined;
}): BindArrival | undefined {
  if (search.bindError !== undefined) {
    return {
      ok: false,
      problem: search.bindError === "github_denied" ? "github_denied" : "github_failed",
    };
  }
  return search.bind !== undefined ? { ok: true } : undefined;
}

/** The first contact offered: the email when there is one. */
export function defaultContact(contacts: PasswordContacts): "email" | "phone" {
  return contacts.email ? "email" : "phone";
}

/** The path that has GitHub confirm the person's identity and come back to this page, open at the
 * Account section. `pathname` must be the page's own (starting with `/`). */
export function githubBindPath(pathname: string): string {
  const returnTo = `${pathname.startsWith("/") ? pathname : `/${pathname}`}?section=account`;
  return `/auth/github?mode=bind&returnTo=${encodeURIComponent(returnTo)}`;
}

export function canSavePassword(code: string, password: string, confirmPassword: string): boolean {
  return isSignInCode(code.trim()) && isNewPassword(password) && password === confirmPassword;
}

export function confirmPasswordProblem(
  password: string,
  confirmPassword: string,
  mode: "blur" | "submit",
): "password_mismatch" | undefined {
  if (mode === "blur" && confirmPassword === "") return undefined;
  return password === confirmPassword ? undefined : "password_mismatch";
}

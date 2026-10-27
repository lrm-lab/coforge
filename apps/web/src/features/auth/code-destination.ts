import { z } from "zod";

/**
 * Where a sign-in verification code goes, and what a code looks like. Shared by the sign-in page,
 * which checks what was typed before asking, and the server, which judges it again.
 */
export type CodeDestination =
  | {
      kind: "phone";
      /** The country calling code; mainland China only for now. */
      countryCode: "+86";
      /** The eleven digits of the mobile number, without the country code. */
      phone: string;
    }
  | { kind: "email"; email: string };

/** What was typed as the phone number or email; `parseCodeDestination` judges it in the handler,
 * so that an unusable one is a result the page shows, not an exception. */
export const typedDestination = z.string().trim().min(1).max(320);

/** Longest email address (RFC 5321). */
const EMAIL_MAX_LENGTH = 254;
const MAINLAND_MOBILE = /^(?:\+86)?(1\d{10})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGN_IN_CODE = /^\d{4,8}$/;

/**
 * What was typed as a destination: an email when it holds an `@` (trimmed, lower-cased), else a
 * mainland China mobile number (eleven digits starting with 1, an optional `+86` before them,
 * spaces and dashes allowed). `null` when it is neither.
 */
export function parseCodeDestination(input: string): CodeDestination | null {
  const typed = input.trim();
  if (typed.includes("@")) {
    const email = typed.toLowerCase();
    return email.length <= EMAIL_MAX_LENGTH && EMAIL.test(email) ? { kind: "email", email } : null;
  }
  const phone = MAINLAND_MOBILE.exec(typed.replace(/[\s-]/g, ""))?.[1];
  return phone ? { kind: "phone", countryCode: "+86", phone } : null;
}

/** The destination in one normalized string (`+8613800138000`, or the email), which the limits
 * count it by. */
export function codeDestinationKey(destination: CodeDestination): string {
  return destination.kind === "email"
    ? destination.email
    : `${destination.countryCode}${destination.phone}`;
}

/** Whether `value` looks like a verification code: four to eight digits. */
export function isSignInCode(value: string): boolean {
  return SIGN_IN_CODE.test(value);
}

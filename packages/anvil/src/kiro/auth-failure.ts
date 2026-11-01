import { RuntimeLoginRequiredError } from "#src/contract";

/**
 * The wording Kiro CLI uses when its stored login is gone or rejected. Measured on kiro-cli 2.33.1
 * (2026-11-01): with no usable login, `acp` writes `error: You are not logged in, please log in
 * with kiro-cli login` to stderr before answering anything, and `chat --no-interactive` reports
 * `The bearer token included in the request is invalid` (403 `AccessDeniedException`, or a 401
 * `UnauthorizedException`) when the stored token is no longer accepted.
 *
 * Only the handshake reads this: a failure during a turn is classified by the daemon, which knows
 * what a person must do about it.
 */
const KIRO_AUTH_FAILURE_PATTERNS = [
  /\bnot logged in\b/i,
  /\bplease (?:log|sign) in\b/i,
  /\blogin required\b/i,
  /\bbearer token\b[^\n]{0,80}\b(?:invalid|expired|missing)\b/i,
  /\b(?:UnauthorizedException|AccessDeniedException)\b[^\n]{0,80}\b(?:token|credential|auth)/i,
  /\b(?:401|403)\b[^\n]{0,80}\b(?:token|credential|auth)/i,
];

export function isKiroAuthFailure(text: string): boolean {
  return KIRO_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/** The typed launch failure a handshake reports once Kiro says its login is not usable. */
export function kiroLoginRequired(): RuntimeLoginRequiredError {
  return new RuntimeLoginRequiredError("Kiro CLI is not logged in on this Computer");
}

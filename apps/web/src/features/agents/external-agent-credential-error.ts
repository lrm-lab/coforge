import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

export function externalCredentialRateLimitMessage(cause: unknown): string | undefined {
  if (!isAppErrorCode(cause, "RATE_LIMITED")) return undefined;
  const seconds = Number(cause.details?.retryAfterSeconds);
  const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 10;
  return m.external_agent_credential_rate_limited({ minutes });
}

export function externalCredentialErrorMessage(cause: unknown): string {
  return externalCredentialRateLimitMessage(cause) ?? m.external_agent_credential_failed();
}

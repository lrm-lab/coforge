import { refusalText } from "@lrm/coforge-sdk/internal";
import { RUNTIME_ERROR_CLASS, classifyRuntimeErrorText } from "./runtime-error-classification";

/**
 * Whether what a runtime said names a credential it refused: an API key it rejects, a login it no
 * longer has (task #39).
 *
 * The typed `RuntimeLoginRequiredError` covers the providers whose adapter can read their own
 * sign-in state; every other provider's refusal arrives as a launch failure whose only evidence is
 * the wording. That wording is the same evidence the mid-turn classifier reads, so one vocabulary
 * decides both — a start that failed for its credential is the sign-in a person must renew, not a
 * launch another attempt can fix.
 */
export function isRefusedCredentialText(error: unknown): boolean {
  return classifyRuntimeErrorText(launchFailureText(error)).errorClass === RUNTIME_ERROR_CLASS.AUTH;
}

/**
 * The failure's words, including the first stderr line a runtime kept beside a generic message: the
 * typed `RuntimeStartFailedError` puts a person-readable `diagnostic` there, and a refused
 * credential is usually only in that line.
 */
function launchFailureText(error: unknown): string {
  const message = refusalText(error);
  const diagnostic =
    error && typeof error === "object" ? Reflect.get(error, "diagnostic") : undefined;
  return typeof diagnostic === "string" && diagnostic.trim() !== ""
    ? `${message}\n${diagnostic}`
    : message;
}

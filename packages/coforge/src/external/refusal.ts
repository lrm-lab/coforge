import { CliError } from "../cli-error";

export const UNSUPPORTED_CODE = "UNSUPPORTED_FOR_EXTERNAL_AGENTS";
const SCHEDULER_ADVICE =
  "Use your own runtime's scheduler, and say in the thread when you will follow up.";

export function unsupportedFeatureError(feature: string | undefined): CliError {
  const named = feature ? ` (${feature})` : "";
  return new CliError({
    code: UNSUPPORTED_CODE,
    message: `This operation is not available to external Agents${named}.`,
    retryable: false,
    ...(feature?.startsWith("reminders.") ? { suggestedNextAction: SCHEDULER_ADVICE } : {}),
  });
}

export function daemonOnlyError(reason: string): CliError {
  return new CliError({ code: UNSUPPORTED_CODE, message: reason, retryable: false });
}

export function profileNotLoggedInError(slug?: string): CliError {
  return new CliError({
    code: "PROFILE_NOT_LOGGED_IN",
    message:
      slug === undefined ? "No Agent profile exists." : `Profile "${slug}" has no credential.`,
    retryable: false,
    suggestedNextAction:
      "Run `coforge agent login --server <url> --agent <id-or-name>` and paste the credential from the Agent's page.",
  });
}

export function invalidCredentialError(): CliError {
  return new CliError({
    code: "EXTERNAL_CREDENTIAL_INVALID",
    message: "The server rejected this Agent's key; it was revoked or replaced.",
    retryable: false,
    suggestedNextAction: "Run `coforge agent login` again for this profile.",
  });
}

export function externalRefusalOf(status: number, body: unknown): CliError | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { code, feature } = body as { code?: unknown; feature?: unknown };
  if (
    (status === 403 && code === "unsupported_for_external_agents") ||
    (status === 409 && code === "reminders_unsupported_for_external_agents")
  )
    return unsupportedFeatureError(typeof feature === "string" ? feature : undefined);
  if (status === 401 && code === "invalid_credential") return invalidCredentialError();
  return undefined;
}

import {
  CREDENTIAL_SOLICITATION_CODE,
  credentialSolicitationMessage,
  solicitsCredentialsInChat,
} from "@lrm/coforge-sdk/internal";

import { CliError } from "./cli-error";
import { hasCloudDesktopEnvironment, refusalNextAction } from "./refusal-guidance";

export function refuseCredentialSolicitationIfNeeded(
  operation: string,
  body: string | undefined,
  target: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): void {
  if (operation !== "send" || typeof body !== "string" || !solicitsCredentialsInChat(body)) {
    return;
  }
  const cloudDesktop = hasCloudDesktopEnvironment(environment);
  throw new CliError({
    code: CREDENTIAL_SOLICITATION_CODE,
    message: credentialSolicitationMessage({ cloudDesktop }),
    retryable: false,
    draftSaved: false,
    suggestedNextAction: refusalNextAction(
      "send",
      { status: 400, code: CREDENTIAL_SOLICITATION_CODE, retryable: false },
      target ?? "",
      { cloudDesktop },
    ),
  });
}

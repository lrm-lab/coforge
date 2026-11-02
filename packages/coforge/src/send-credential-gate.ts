import {
  CREDENTIAL_SOLICITATION_CODE,
  CREDENTIAL_SOLICITATION_MESSAGE,
  solicitsCredentialsInChat,
} from "@lrm/coforge-sdk/internal";

import { CliError } from "./cli-error";
import { refusalNextAction } from "./refusal-guidance";

/** Refuse before the proxy: secrets belong on a page:fill / desktop:takeover card, not in chat. */
export function refuseCredentialSolicitationIfNeeded(
  operation: string,
  body: string | undefined,
  target: string | undefined,
): void {
  if (operation !== "send" || typeof body !== "string" || !solicitsCredentialsInChat(body)) {
    return;
  }
  throw new CliError({
    code: CREDENTIAL_SOLICITATION_CODE,
    message: CREDENTIAL_SOLICITATION_MESSAGE,
    retryable: false,
    draftSaved: false,
    suggestedNextAction: refusalNextAction(
      "send",
      { status: 400, code: CREDENTIAL_SOLICITATION_CODE, retryable: false },
      target ?? "",
    ),
  });
}

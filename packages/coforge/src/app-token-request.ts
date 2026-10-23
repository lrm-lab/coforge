import type { AgentAppTokenResponse } from "@lrm/coforge-sdk/agent";
import type { AppClient } from "./app-client";
import { CliError } from "./cli-error";

/** Exit status when the app needs a person's approval first: nothing was run or sent. */
export const APPROVAL_REQUIRED_EXIT_CODE = 2;

/** Asks for an app token. A CONFLICT is a lost race with a concurrent use of the same app: asking
 * once more settles it. The one path `app token` and `app invoke` share. */
export async function requestAppToken(
  client: Pick<AppClient, "appToken">,
  appKey: string,
  target?: string,
): Promise<AgentAppTokenResponse> {
  const ask = () => client.appToken(appKey, target);
  return ask().catch((error: unknown) => {
    if (error instanceof CliError && error.code === "CONFLICT") return ask();
    throw error;
  });
}

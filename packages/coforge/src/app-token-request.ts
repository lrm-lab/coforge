import type { AgentAppTokenResponse } from "@lrm/coforge-sdk/agent";
import type { AppClient } from "./app-client";
import { CliError } from "./cli-error";

/** Exit status when the app needs a person's approval first: nothing was run or sent. */
export const APPROVAL_REQUIRED_EXIT_CODE = 2;

/** Asks for an app token. A CONFLICT is a lost race with a concurrent use of the same app: asking
 * once more settles it. The one path `app token` and `app invoke` share. A request that carried
 * `scopes` and was refused as invalid came through a running Computer that predates scoped
 * tokens; it is never retried without them, since that would ask for more than was meant. */
export async function requestAppToken(
  client: Pick<AppClient, "appToken">,
  appKey: string,
  target?: string,
  scopes?: string[],
  outputMode?: "text" | "json",
): Promise<AgentAppTokenResponse> {
  const ask = () => client.appToken(appKey, target, scopes);
  return ask().catch((error: unknown) => {
    if (error instanceof CliError && error.code === "CONFLICT") return ask();
    if (scopes !== undefined && error instanceof CliError && error.code === "REQUEST_INVALID")
      throw new CliError({
        code: "TOKEN_SCOPES_UNSUPPORTED",
        message:
          "The running CoForge Computer predates scoped app tokens, so it refused the request; nothing was run or sent.",
        retryable: false,
        effect: "none",
        suggestedNextAction:
          "Restart it with `coforge-computer restart`, then run this command again.",
        outputMode,
      });
    throw error;
  });
}

/** Why an issued token cannot be used for the `asked` scopes, or `undefined` when it can: a server
 * that predates the `scopes` request field ignores it and issues the grant's scopes, which may
 * lack some. Anything but an issued token, or no scopes asked, is fine here. */
export function uncoveredScopesMessage(
  appKey: string,
  answer: AgentAppTokenResponse,
  asked: readonly string[] | undefined,
): string | undefined {
  if (answer.status !== "issued" || !asked) return undefined;
  const granted = new Set(answer.scope.split(" "));
  const missing = asked.filter((scope) => !granted.has(scope));
  return missing.length === 0
    ? undefined
    : `The token for ${appKey} lacks the scope${missing.length === 1 ? "" : "s"} ${missing.join(", ")} that was asked for (this CoForge server may predate scope requests, or the app's grant was narrowed); nothing was run or sent.`;
}

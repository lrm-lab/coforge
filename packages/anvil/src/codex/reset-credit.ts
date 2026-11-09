import { getLogger } from "@logtape/logtape";
import { type ResetCreditOutcome, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { JsonlRequestError, asRecord, isVersionBelow } from "@lrm/coforge-anvil";

import { openCodexAppServer } from "./app-server-session";
import type { CodexUsageHost } from "./host";
import { isNonSubscription } from "./usage";

const logger = getLogger([
  "coforge",
  "daemon",
  "code-agent",
  RUNTIME_PROVIDER.CODEX,
  "reset-credit",
]);

/** The first stable Codex whose app-server has `account/rateLimitResetCredit/consume`: openai/codex
 * PR #28143 (merged 2026-06-15, commit bef99f86) is contained in `rust-v0.141.0` (published
 * 2026-06-18) and not in `rust-v0.140.0`. */
export const CODEX_RESET_CREDIT_MINIMUM_VERSION = "0.141.0";
/** One attempt's budget for each request it makes. */
export const CODEX_RESET_CREDIT_TIMEOUT_MS = 20_000;

const WIRE_OUTCOMES: Readonly<Record<string, ResetCreditOutcome>> = {
  reset: "reset",
  nothingToReset: "nothing_to_reset",
  noCredit: "no_credit",
  alreadyRedeemed: "already_redeemed",
};

/** JSON-RPC "method not found": the request was refused before any handler ran. */
const METHOD_NOT_FOUND = -32601;

class ResetCreditTimeoutError extends Error {
  constructor() {
    super("Codex reset credit request timed out");
  }
}

/**
 * Spends one of the signed-in account's rate-limit reset credits through the app-server, with the
 * experimental API like the usage read. `idempotencyKey` names one logical attempt and goes to
 * Codex as given, so a retry after `unknown` cannot spend a second credit; no `creditId` is sent,
 * so the backend picks the credit. Only an answer that settles the attempt, or a refusal before
 * the request could reach the backend (an app-server without the method, a Codex below
 * `CODEX_RESET_CREDIT_MINIMUM_VERSION`, an account that cannot hold a credit, a signed-out
 * runtime), says anything but `unknown`: a timeout, a closed process or an error reply leave it
 * open. The key and the account are never logged.
 */
export async function consumeCodexResetCredit(
  workingDirectory: string,
  options: {
    host: CodexUsageHost;
    command?: readonly string[];
    idempotencyKey: string;
    /** Each request's budget; only a test that waits on a stuck app-server shortens it. */
    timeoutMs?: number;
  },
): Promise<ResetCreditOutcome> {
  const settle = (outcome: ResetCreditOutcome, reason?: string) => {
    logger.info("Codex reset credit attempt ended", {
      event: "code_agent.reset_credit.consume",
      provider: RUNTIME_PROVIDER.CODEX,
      outcome,
      ...(reason ? { reason } : {}),
    });
    return outcome;
  };
  const session = openCodexAppServer(workingDirectory, {
    host: options.host,
    command: options.command,
    timeoutMs: options.timeoutMs ?? CODEX_RESET_CREDIT_TIMEOUT_MS,
    timeoutError: () => new ResetCreditTimeoutError(),
  });
  try {
    const server = await session.start();
    const version = codexVersion(server.userAgent);
    if (version && isVersionBelow(version, CODEX_RESET_CREDIT_MINIMUM_VERSION))
      return settle("unsupported", "version_below_minimum");
    // An app-server that predates `account/read` is still asked.
    const account = await server.readAccount();
    if (account && isNonSubscription(account)) return settle("unsupported", "no_plan");
    if (account && !asRecord(account.account)) return settle("reauth_required", "signed_out");
    let response: Readonly<Record<string, unknown>>;
    try {
      response = await server.request("account/rateLimitResetCredit/consume", {
        idempotencyKey: options.idempotencyKey,
      });
    } catch (error) {
      return error instanceof JsonlRequestError &&
        asRecord(error.responseError)?.code === METHOD_NOT_FOUND
        ? settle("unsupported", "method_not_found")
        : settle("unknown", failureKind(error));
    }
    const wire = asRecord(response.result)?.outcome;
    const outcome = typeof wire === "string" ? WIRE_OUTCOMES[wire] : undefined;
    return outcome ? settle(outcome) : settle("unknown", "unreadable_outcome");
  } catch (error) {
    return settle("unknown", failureKind(error));
  } finally {
    await session.dispose();
  }
}

/** Why an attempt ended open, in words that carry no provider text. */
function failureKind(error: unknown): string {
  if (error instanceof ResetCreditTimeoutError) return "timeout";
  return error instanceof JsonlRequestError ? "error_reply" : "transport";
}

/** The Codex version in the app-server's `userAgent`, `<originator>/<version> (<os>; <arch>) …`,
 * as `get_codex_user_agent` builds it. */
function codexVersion(userAgent: unknown): string | undefined {
  return typeof userAgent === "string"
    ? userAgent.match(/^[^/\s]+\/(\d+\.\d+\.\d+)/u)?.[1]
    : undefined;
}

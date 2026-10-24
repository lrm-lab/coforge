import type { AgentProxyFailureDetails } from "@lrm/coforge-sdk/internal";
import { AGENT_MESSAGE_DRAFT_TTL_MS } from "#src/persistence/agent-message-draft-store";
import type { AgentSendVerdict } from "./agent-send-verdict";

/**
 * A local precondition that failed before `DaemonRuntime` ever issued a request to the Web/backend
 * server: an invalid Agent local context, a runtime that is not started or connected, a missing
 * Agent API key, or a `--send-draft` request whose draft is missing, expired, or now belongs to a
 * different send. These are safe to describe to the Agent (they name a caller-fixable local
 * condition, never upstream/transport detail) and are reported by `agent-proxy-failure.ts` as
 * `local_precondition`, distinct from a transport failure.
 *
 * `verdict.draftSaved` defaults to `undefined` (rendered as `false` by `agent-proxy-failure.ts`);
 * the `--target-confirmed` guard is the one caller that saves a draft before throwing.
 * `verdict.suggestedNextAction` replaces the CLI's generic "fix the problem and run it again" line
 * when the right next step is something else. `details` is code-specific data for `--json`
 * (`SEND_DRAFT_EXPIRED` carries `discarded_draft`), in the proxy contract's snake_case.
 */
export class AgentPreflightError extends Error {
  readonly code: string;
  readonly verdict: AgentSendVerdict;
  readonly details?: AgentProxyFailureDetails;

  constructor(
    message: string,
    code: string,
    verdict: AgentSendVerdict = {},
    details?: AgentProxyFailureDetails,
  ) {
    super(message);
    this.name = "AgentPreflightError";
    this.code = code;
    this.verdict = verdict;
    this.details = details;
  }
}

/** `SEND_DRAFT_EXPIRED`: nothing is sent. The entry is gone, so the discarded body travels once,
 * in `details.discarded_draft`, which the CLI prints as its last copy. */
export function expiredDraftError(
  target: string,
  content: string,
  savedAt: number,
): AgentPreflightError {
  const savedAtIso = new Date(savedAt).toISOString();
  return new AgentPreflightError(
    `The saved draft for this target expired and was discarded: drafts are kept for ${AGENT_MESSAGE_DRAFT_TTL_MS / 60_000} minutes, and this one was saved at ${savedAtIso}. This command did not send anything.`,
    "SEND_DRAFT_EXPIRED",
    {
      draftSaved: false,
      retryable: false,
      suggestedNextAction:
        "If this draft came from a failed send whose outcome was never confirmed, the original " +
        "may already have been delivered under its idempotency key: read the target and confirm " +
        "before resending, or you may post it twice. To send the discarded body, send it normally: " +
        `\`coforge message send --target ${JSON.stringify(target)}\` with the body on stdin.`,
    },
    { discarded_draft: { content, saved_at: savedAtIso } },
  );
}

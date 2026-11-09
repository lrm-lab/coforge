import { asRecord, type AgentRuntimeEvent } from "@lrm/coforge-anvil";

type SessionRecovery = NonNullable<
  Extract<AgentRuntimeEvent, { type: "error" }>["sessionRecovery"]
>;

export type CodexTurnOutcome = {
  status: "completed" | "interrupted" | "failed";
  /** Only on a failed turn: the provider's raw message (unscrubbed, uncapped) and its code. */
  failure?: {
    message: string;
    code?: string;
    /** The stored thread cannot be continued: the API rejected its encrypted reasoning. */
    sessionRecovery?: SessionRecovery;
  };
};

/**
 * A thread resumed against another backend or key (a custom `model_provider`, a changed API key, a
 * gateway) has its encrypted reasoning rejected on the next turn (openai/codex#17541). Codex's
 * `TurnError` is `{ message, codexErrorInfo, additionalDetails, misalignment }` with no code of
 * its own (app-server schema, 0.167.0), so the API's text arrives in `message` or
 * `additionalDetails`; a `code` is honoured should a build send one. Nothing wider matches: the
 * token `invalid_encrypted_content`, or "encrypted content" together with "could not be decrypted
 * or parsed" in one text (another component's decrypt failure keeps the session).
 */
function sessionRecoveryOf(
  code: string | undefined,
  ...texts: readonly (string | undefined)[]
): SessionRecovery | undefined {
  return code === "invalid_encrypted_content" ||
    texts.some((text) => {
      const lower = text?.toLowerCase();
      return (
        lower?.includes("invalid_encrypted_content") ||
        (lower?.includes("encrypted content") && lower.includes("could not be decrypted or parsed"))
      );
    })
    ? "provider_replay_rejected"
    : undefined;
}

/**
 * How one Codex `turn/completed` turn ended. Any status other than `completed` or `interrupted`
 * is a failure. Raw facts only: the daemon core owns redaction and truncation for the visible
 * Activity.
 */
export function codexTurnOutcome(turn: Readonly<Record<string, unknown>>): CodexTurnOutcome {
  const status =
    turn.status === "interrupted"
      ? "interrupted"
      : turn.status === "completed"
        ? "completed"
        : "failed";
  if (status !== "failed") return { status };
  const error = asRecord(turn.error);
  const message = typeof error?.message === "string" ? error.message : "Codex turn failed.";
  const code = typeof error?.code === "string" ? error.code : undefined;
  const details =
    typeof error?.additionalDetails === "string" ? error.additionalDetails : undefined;
  const sessionRecovery = sessionRecoveryOf(code, message, details);
  return {
    status,
    failure: {
      message,
      ...(code !== undefined ? { code } : {}),
      ...(sessionRecovery ? { sessionRecovery } : {}),
    },
  };
}

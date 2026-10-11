import { asRecord } from "#src/code-agent/json-record";

export type CodexTurnOutcome = {
  status: "completed" | "interrupted" | "failed";
  /** Only on a failed turn: the provider's raw message (unscrubbed, uncapped) and its code. */
  failure?: { message: string; code?: string };
};

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
  return {
    status,
    failure: {
      message: typeof error?.message === "string" ? error.message : "Codex turn failed.",
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
    },
  };
}

// A stop reason outside the standard ACP `end_turn`/`cancelled` pair (Kiro's private "error"
// value included) always ends the turn as a failure; these are the fixed, CoForge-worded
// fallbacks used only when the turn carried no more specific reason of its own.
export const STOP_REASON_FAILURE_MESSAGES: Readonly<Partial<Record<string, string>>> = {
  error: "Kiro ended the turn with an error",
  max_tokens: "Kiro reached its token limit before finishing the turn",
  max_turn_requests: "Kiro reached its turn request limit before finishing the turn",
  refusal: "Kiro refused to continue the turn",
};

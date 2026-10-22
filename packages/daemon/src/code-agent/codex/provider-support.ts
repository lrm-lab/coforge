import {
  AGENT_SERVICE_TIER_OBSERVED,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
import { asRecord } from "#src/code-agent/json-record";

export type CodexSessionState =
  | { type: "idle" }
  | { type: "starting"; completedTurnIds: Set<string> }
  | { type: "running"; turnId: string }
  | { type: "interrupting"; turnId: string }
  | { type: "disposed" };

export function assertSkillsLoaded(response: Record<string, unknown>, cwd: string): void {
  const data = asRecord(response.result)?.data;
  if (!Array.isArray(data)) throw new Error("Codex did not report loaded skills");
  const workspace = data.map(asRecord).find((entry) => entry?.cwd === cwd);
  if (!workspace || !Array.isArray(workspace.errors) || workspace.errors.length > 0) {
    throw new Error("Codex failed to load workspace skills");
  }
}

// Bounds only the daemon's own structured log line (`codex.turn.failed`), never the visible
// Activity: the daemon core owns redaction/truncation for anything shown to a user (see
// agent-runtime/runtime-error-activity.ts, the single place that happens for every provider).
export function scrubError(message: string): string {
  return message
    .replace(/(?:sk|pk|api|token|key|secret)[_-]?[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

/**
 * The service tier codex reports it applied to a thread, normalized to the SDK's closed
 * vocabulary, or `undefined` when this build reported none. Measured on codex-cli 0.163.0
 * (2026-10-21) against a real `thread/start`:
 * requesting `"fast"` and requesting `"priority"` both answer `"priority"`, requesting nothing
 * answers `"default"`, and a value it does not recognize answers `null` (it does not error). So a
 * launch that asked for Fast and did not get it is visible here, which is the whole point of
 * reporting it.
 */
export function codexServiceTierState(value: unknown): AgentServiceTierObserved | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "priority" || value === "fast") return AGENT_SERVICE_TIER_OBSERVED.ON;
  if (value === "default") return AGENT_SERVICE_TIER_OBSERVED.OFF;
  return AGENT_SERVICE_TIER_OBSERVED.UNREPORTED;
}

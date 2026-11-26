import type { AgentRuntimeEvent } from "@coforge/agent";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  codePointLength,
  truncateCodePoints,
  type ActivitySubagent,
  type AgentActivityDetailKind,
} from "@lrm/coforge-sdk/internal";
import { createAgentActivity, redactTrajectoryText } from "@lrm/coforge-anvil";
import { PHASE_BOUNDARY_EVENT_TYPES } from "./runtime-phases";

/**
 * True when `event` means the model moved on from an open thinking run: a rendered
 * response resuming, a tool call starting or ending, a phase boundary (context compaction,
 * review mode), the turn ending, an error or a retry. `runtime_progress`, `session` and `usage` events
 * never end thinking, and neither does a further `thinking-delta` (it continues the same run).
 */
function endsThinking(event: AgentRuntimeEvent): boolean {
  if (PHASE_BOUNDARY_EVENT_TYPES.has(event.type)) return true;
  switch (event.type) {
    case "text-delta":
    case "tool-start":
    case "tool-end":
    case "completed":
    case "error":
    case "reconnecting":
      return true;
    case "activity":
      return event.activity.level === "error";
    default:
      return false;
  }
}

/** How long a text or thinking run stays quiet before its pending text is flushed as a row. */
export const TRAJECTORY_QUIET_WINDOW_MS = 350;

export class ActivityTrajectory {
  #pending?: {
    kind: "text" | "thinking";
    text: string;
    subagent?: ActivitySubagent;
    truncated: boolean;
  };
  #timer?: ReturnType<typeof setTimeout>;
  #flushAtMs = 0;
  #disposed = false;
  #lastAnnounced?: AgentActivityDetailKind;
  constructor(private readonly emit: (event: AgentRuntimeEvent) => void) {}

  accept(event: AgentRuntimeEvent) {
    if (this.#disposed) return;
    if (
      this.#lastAnnounced === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED &&
      endsThinking(event)
    ) {
      this.flush();
      this.#forward({
        type: "activity",
        activity: createAgentActivity(
          AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
          "info",
          "Thinking finished",
        ),
      });
    }
    if (event.type === "text-delta" || event.type === "thinking-delta") {
      const kind = event.type === "text-delta" ? "text" : "thinking";
      if (
        this.#pending &&
        (this.#pending.kind !== kind ||
          this.#pending.subagent?.parentToolUseId !== event.subagent?.parentToolUseId)
      )
        this.flush();
      if (!this.#pending) this.#startRun(kind);
      const pending = this.#pending ?? {
        kind,
        text: "",
        subagent: event.subagent,
        truncated: false,
      };
      const last = pending.truncated ? pending.text.charCodeAt(pending.text.length - 1) : 0;
      if (!pending.truncated || (last >= 0xd800 && last <= 0xdbff)) {
        const text = pending.text + event.text;
        if (text.length <= 8000) {
          pending.text = text;
        } else {
          pending.truncated ||= codePointLength(text) > 8000;
          pending.text = truncateCodePoints(text, 8000);
        }
      }
      this.#pending = pending;
      this.#flushAtMs = Date.now() + TRAJECTORY_QUIET_WINDOW_MS;
      if (this.#timer === undefined) this.#armTimer(TRAJECTORY_QUIET_WINDOW_MS);
      return;
    }
    if (
      event.type === "tool-start" ||
      event.type === "activity" ||
      event.type === "completed" ||
      PHASE_BOUNDARY_EVENT_TYPES.has(event.type) ||
      event.type === "subagent-progress" ||
      event.type === "error" ||
      event.type === "reconnecting"
    )
      this.flush();
    this.#forward(event);
  }

  #armTimer(delayMs: number) {
    const timer = setTimeout(() => this.#onTimer(), delayMs);
    timer?.unref?.();
    this.#timer = timer;
  }

  #onTimer() {
    this.#timer = undefined;
    if (this.#disposed || !this.#pending) return;
    const remaining = this.#flushAtMs - Date.now();
    if (remaining > 0) {
      this.#armTimer(Math.min(remaining, TRAJECTORY_QUIET_WINDOW_MS));
      return;
    }
    this.flush();
  }

  #startRun(kind: "text" | "thinking") {
    const detailKind =
      kind === "thinking"
        ? AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED
        : AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED;
    if (detailKind === this.#lastAnnounced) return;
    this.#forward({ type: "activity", activity: createAgentActivity(detailKind, "info", "") });
  }

  #forward(event: AgentRuntimeEvent) {
    if (
      event.type === "activity" &&
      event.activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS
    )
      this.#lastAnnounced = event.activity.detailKind;
    if (event.type === "tool-start") this.#lastAnnounced = AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED;
    if (event.type === "reconnecting")
      this.#lastAnnounced = AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING;
    this.emit(event);
  }

  flush() {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#flushAtMs = 0;
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    const redacted = redactTrajectoryText(pending.text);
    const text =
      pending.truncated || (redacted.length > 2000 && codePointLength(redacted) > 2000)
        ? `${truncateCodePoints(redacted, 1999)}…`
        : redacted;
    if (!text.trim()) return;
    this.#forward({
      type: "activity",
      activity: {
        detailKind:
          pending.kind === "thinking"
            ? AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED
            : AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED,
        level: "info",
        detail: "",
        observedAtMs: Date.now(),
        entries: [
          { kind: pending.kind, text, ...(pending.subagent ? { subagent: pending.subagent } : {}) },
        ],
      },
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.flush();
    this.#disposed = true;
  }
}

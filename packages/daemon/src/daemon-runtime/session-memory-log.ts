import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * Why this launch did or did not open with the two memory files: one line per launch, so "the
 * block never arrived" is answerable from the log instead of inferred. `reason` names the branch
 * that decided it — a recycle already carries its own briefing, a resume still has its context,
 * and a fresh session is either an explicit create or one with no session to continue.
 */
export function noteSessionMemory(input: {
  agentId: string;
  launchId: string;
  freshSession: boolean;
  injected: boolean;
  recycled: boolean;
  sessionMode?: "create" | "resume";
  hadSessionId: boolean;
}): void {
  const reason = input.recycled
    ? "recycle"
    : !input.freshSession
      ? "resume"
      : input.sessionMode === "create"
        ? "create"
        : "no_session";
  logger.info("Agent session memory decision", {
    event: "agent.runtime.session_memory",
    agent_id: input.agentId,
    launch_id: input.launchId,
    injected: input.injected,
    has_memory_block: input.injected,
    reason,
    ...(input.sessionMode ? { session_mode: input.sessionMode } : {}),
    had_session_id: input.hadSessionId,
  });
}

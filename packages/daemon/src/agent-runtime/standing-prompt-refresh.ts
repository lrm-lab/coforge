import { getLogger } from "@logtape/logtape";
import {
  queueHasInputContent,
  recoveryHasContent,
  type AgentInput,
  type AgentInputQueue,
} from "#src/daemon-runtime/runtime-launch-intent";
import {
  standingPromptHash,
  type StandingPromptRecord,
} from "#src/persistence/agent-standing-prompt-ledger";

const logger = getLogger(["coforge", "daemon", "runtime"]);

const STANDING_PROMPT_UPDATE_NOTE =
  "That is an updated standing instruction block as context, not a user request: apply it for the rest of this session and do not reply to it; your next input follows.";

export type StandingPromptRefreshPlan =
  | Readonly<{ action: "none" }>
  | Readonly<{ action: "unchanged" }>
  | Readonly<{ action: "baseline_unknown"; currentHash: string }>
  | Readonly<{
      action: "inject";
      staleForMs: number;
      previousHash: string;
      currentHash: string;
    }>;

export function formatStandingPromptUpdate(instructions: string): string {
  return [
    "<standing-prompt-update>",
    "CoForge updated your standing instructions since this session started. The instructions below supersede your earlier standing instructions for the rest of this session; follow these wherever they differ.",
    "",
    instructions,
    "</standing-prompt-update>",
  ].join("\n");
}

export function standingPromptUpdateStandalone(instructions: string): string {
  return `${formatStandingPromptUpdate(instructions)}\n\n${STANDING_PROMPT_UPDATE_NOTE}`;
}

export function planStandingPromptRefresh(input: {
  instructions: string;
  resumeSessionId: string | undefined;
  refreshesOnResume: boolean;
  previous: StandingPromptRecord | undefined;
  nowMs?: number;
}): StandingPromptRefreshPlan {
  if (!input.resumeSessionId || input.refreshesOnResume || !input.instructions.trim())
    return { action: "none" };
  const currentHash = standingPromptHash(input.instructions);
  const { previous } = input;
  if (!previous || previous.sessionId !== input.resumeSessionId) {
    return { action: "baseline_unknown", currentHash };
  }
  if (previous.hash === currentHash) return { action: "unchanged" };
  const nowMs = input.nowMs ?? Date.now();
  return {
    action: "inject",
    staleForMs: Math.max(0, nowMs - previous.recordedAtMs),
    previousHash: previous.hash,
    currentHash,
  };
}

export function prependStandingPromptUpdate(
  queue: AgentInputQueue | undefined,
  instructions: string,
): boolean {
  if (!queue || queue.closed || !instructions.trim()) return false;
  const block = formatStandingPromptUpdate(instructions);
  const starter = queue.items.find(
    (item): item is Extract<AgentInput, { kind: "startup" }> => item.kind === "startup",
  );
  const behind = queue.items.filter((item) => item.kind !== "startup");
  if (starter && !queueHasInputContent(behind)) {
    starter.text = `${block}\n\n${starter.text}`;
    return true;
  }
  const first = behind.find(
    (item) =>
      item.kind === "delivery" ||
      item.kind === "prompt" ||
      (item.kind === "recovery" && recoveryHasContent(item.context)),
  );
  if (first?.kind === "prompt") {
    first.text = `${block}\n\n${first.text}`;
    return true;
  }
  const completion = Promise.withResolvers<void>();
  completion.promise.catch(() => {});
  queue.items.unshift({
    kind: "memory",
    text: standingPromptUpdateStandalone(instructions),
    completion: { resolve: completion.resolve, reject: completion.reject },
  });
  return true;
}

export function refreshLaunchStandingPrompt(input: {
  agentId: string;
  launchId: string;
  provider: string;
  instructions: string;
  activeSessionId: string | undefined;
  resumedSameSession: boolean;
  refreshesOnResume: boolean;
  previous: StandingPromptRecord | undefined;
  prependUpdate: (instructions: string) => boolean;
  record: (sessionId: string | undefined, resumed: boolean) => void;
  nowMs?: number;
}): boolean {
  const plan = planStandingPromptRefresh({
    instructions: input.instructions,
    resumeSessionId: input.resumedSameSession ? input.activeSessionId : undefined,
    refreshesOnResume: input.refreshesOnResume,
    previous: input.previous,
    nowMs: input.nowMs,
  });
  if (plan.action === "inject") {
    const injected = input.prependUpdate(input.instructions);
    logger.info("Standing prompt changed on resumed Agent session", {
      event: "agent.runtime.standing_prompt_stale",
      agent_id: input.agentId,
      launch_id: input.launchId,
      provider: input.provider,
      ...(input.activeSessionId ? { session_id: input.activeSessionId } : {}),
      action: injected ? "injected" : "skipped_no_queue",
      stale_for_ms: plan.staleForMs,
      previous_hash: plan.previousHash,
      current_hash: plan.currentHash,
    });
    if (injected) input.record(input.activeSessionId, true);
    return injected && Boolean(input.activeSessionId);
  }
  if (plan.action === "baseline_unknown") {
    logger.info("Standing prompt baseline unknown on resumed Agent session", {
      event: "agent.runtime.standing_prompt_stale",
      agent_id: input.agentId,
      launch_id: input.launchId,
      provider: input.provider,
      ...(input.activeSessionId ? { session_id: input.activeSessionId } : {}),
      action: "baseline_unknown",
      current_hash: plan.currentHash,
    });
  }
  input.record(input.activeSessionId, input.resumedSameSession);
  return Boolean(input.activeSessionId);
}

import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useAppToast } from "#src/components/ui/toast";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import {
  readAgentTurnInterrupt,
  startAgentTurnInterrupt,
} from "#src/features/agents/agent-turn-interrupt.functions";
import { interruptAgentTurnOutcome } from "#src/features/agents/agent-turn-interrupt-poll";
import type { AgentTurnInterruptOutcome } from "#src/server/agents/agent-turn-interrupt.server";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import { m } from "#src/paraglide/messages";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { AgentErrorBanner, type AgentRetry } from "./agent-error-banner";

type Outcome = AgentTurnInterruptOutcome;
type Failure = Extract<Outcome, "needs_upgrade" | "offline" | "failed">;

const OUTCOME_TEXT: Record<Outcome, () => string> = {
  interrupted: m.agent_turn_stop_interrupted,
  restarted: m.agent_turn_stop_restarted,
  not_running: m.agent_turn_stop_not_running,
  unsupported: m.agent_turn_stop_unsupported,
  needs_upgrade: m.agent_turn_stop_upgrade,
  offline: m.agent_turn_stop_offline,
  failed: m.agent_turn_stop_failed,
};

/** The cloud decides when a turn is stalled; the panel only offers its scoped interrupt here. */
export function AgentProfileStatus({
  agent,
  display,
  onActivityTab,
  onViewLogs,
  retry,
}: {
  agent: AgentDiagnosticFacts;
  display?: AgentDisplaySnapshot;
  onActivityTab: boolean;
  onViewLogs?: () => void;
  retry?: AgentRetry;
}) {
  const stalled = display?.detailKind === "runtime_stalled" && display.activityKind !== "offline";
  if (stalled) return <StalledTurnStatus agentId={agent.id} />;
  // A quota gone stops the Agent, so it is offline, yet someone still has to act on it.
  return display?.activityKind === "error" || agentDisplay(display).alert ? (
    <AgentErrorBanner
      agent={agent}
      display={display!}
      onActivityTab={onActivityTab}
      onViewLogs={onViewLogs}
      retry={retry}
    />
  ) : null;
}

/** Unmounting on recovery also discards feedback from the preceding stalled turn. */
function StalledTurnStatus({ agentId }: { agentId: string }) {
  const start = useServerFn(startAgentTurnInterrupt);
  const read = useServerFn(readAgentTurnInterrupt);
  const toast = useAppToast();
  const [pending, guard] = useSubmitGuard();
  const [failure, setFailure] = useState<Failure | null>(null);
  // The Daemon ends the stalled display before it reports, which unmounts this panel while the
  // poll runs. The poll is not cancelled and the toast is still shown; only this component's own
  // state is guarded.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function stopTurn() {
    void guard(async () => {
      setFailure(null);
      const outcome = await interruptAgentTurnOutcome({
        start: () => start({ data: { agentId } }),
        read: (requestId) => read({ data: { agentId, requestId } }),
      });
      if (outcome === "needs_upgrade" || outcome === "offline" || outcome === "failed") {
        if (mounted.current) setFailure(outcome);
      } else toast.success(OUTCOME_TEXT[outcome]());
    });
  }

  return (
    <div className="shrink-0 border-b border-secondary px-5 py-2.5 text-sm">
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip title={m.agent_turn_stalled_hint()}>
          <TooltipTrigger className="cursor-default text-warning-primary">
            {m.agent_turn_stalled()}
          </TooltipTrigger>
        </Tooltip>
        <Button
          color="link-gray"
          size="sm"
          className="*:data-text:decoration-fg-quaternary *:data-text:underline-offset-2"
          isDisabled={pending}
          onPress={stopTurn}
        >
          {pending
            ? m.agent_turn_stop_pending()
            : failure === "failed"
              ? m.agent_turn_stop_retry()
              : m.agent_turn_stop()}
        </Button>
      </div>
      {failure && (
        <p role="alert" className="mt-1 text-error-primary">
          {OUTCOME_TEXT[failure]()}
        </p>
      )}
    </div>
  );
}

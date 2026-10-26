import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useAppToast } from "#src/components/ui/toast";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { interruptAgentTurn } from "#src/features/agents/agent-turn-interrupt.functions";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import { m } from "#src/paraglide/messages";
import { AgentErrorBanner } from "./agent-error-banner";

type Outcome = Awaited<ReturnType<typeof interruptAgentTurn>>;
type Failure = Extract<Outcome, "needs_upgrade" | "offline" | "failed">;

const OUTCOME_TEXT: Record<Outcome, () => string> = {
  interrupted: m.agent_turn_stop_interrupted,
  restarted: m.agent_turn_stop_restarted,
  not_running: m.agent_turn_stop_not_running,
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
}: {
  agent: AgentDiagnosticFacts;
  display?: AgentDisplaySnapshot;
  onActivityTab: boolean;
  onViewLogs?: () => void;
}) {
  const stalled = display?.detailKind === "runtime_stalled" && display.activityKind !== "offline";
  if (stalled) return <StalledTurnStatus agentId={agent.id} />;
  return display?.activityKind === "error" ? (
    <AgentErrorBanner
      agent={agent}
      display={display}
      onActivityTab={onActivityTab}
      onViewLogs={onViewLogs}
    />
  ) : null;
}

/** Unmounting on recovery also discards feedback from the preceding stalled turn. */
function StalledTurnStatus({ agentId }: { agentId: string }) {
  const interrupt = useServerFn(interruptAgentTurn);
  const toast = useAppToast();
  const [pending, guard] = useSubmitGuard();
  const [failure, setFailure] = useState<Failure | null>(null);

  function stopTurn() {
    void guard(async () => {
      setFailure(null);
      try {
        const outcome = await interrupt({
          data: { agentId, requestId: crypto.randomUUID() },
        });
        if (outcome === "needs_upgrade" || outcome === "offline" || outcome === "failed")
          setFailure(outcome);
        else toast.success(OUTCOME_TEXT[outcome]());
      } catch {
        setFailure("failed");
      }
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

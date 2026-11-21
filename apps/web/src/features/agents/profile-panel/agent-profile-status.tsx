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
import type { AgentWakeBlock } from "#src/server/agents/agent-wake-block.server";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import { m } from "#src/paraglide/messages";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { agentReadinessLine } from "./agent-readiness-line";
import { AgentErrorBanner, type AgentRetry } from "./agent-error-banner";
import { AgentReadinessNote, type AgentReadinessNoteData } from "./agent-readiness-note";
import { AgentWakeBlockNote } from "./agent-wake-block-note";

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

export function AgentProfileStatus({
  agent,
  display,
  onActivityTab,
  onViewLogs,
  retry,
  needsManualStart,
  canRetryManualStart,
  wakeBlock,
  readiness,
  onOpenSettings,
}: {
  agent: AgentDiagnosticFacts;
  display?: AgentDisplaySnapshot;
  onActivityTab: boolean;
  onViewLogs?: () => void;
  retry?: AgentRetry;
  needsManualStart?: boolean;
  canRetryManualStart?: boolean;
  wakeBlock?: AgentWakeBlock | null;
  readiness?: AgentReadinessNoteData;
  onOpenSettings?: () => void;
}) {
  const stalled = display?.detailKind === "runtime_stalled" && display.activityKind !== "offline";
  const note = wakeBlock ? <AgentWakeBlockNote block={wakeBlock} retry={retry} /> : null;
  if (stalled)
    return (
      <>
        <StalledTurnStatus agentId={agent.id} />
        {note}
      </>
    );
  const blockedManualStart =
    needsManualStart && readiness && agentReadinessLine(readiness.readiness) !== "launch_failed";
  if (readiness && (display?.activityKind !== "error" || blockedManualStart))
    return (
      <>
        <AgentReadinessNote
          data={readiness}
          needsManualStart={needsManualStart}
          agent={agent}
          display={display}
          onViewLogs={blockedManualStart && onActivityTab ? undefined : onViewLogs}
          onOpenSettings={onOpenSettings}
          retry={needsManualStart && !canRetryManualStart ? undefined : retry}
        />
        {note}
      </>
    );
  const alert = display?.activityKind === "error" || agentDisplay(display).alert;
  if (!alert) return note;
  return (
    <>
      <AgentErrorBanner
        agent={agent}
        display={display!}
        needsManualStart={needsManualStart}
        canRetryManualStart={canRetryManualStart}
        onActivityTab={onActivityTab}
        onViewLogs={onViewLogs}
        retry={retry}
      />
      {note}
    </>
  );
}

function StalledTurnStatus({ agentId }: { agentId: string }) {
  const start = useServerFn(startAgentTurnInterrupt);
  const read = useServerFn(readAgentTurnInterrupt);
  const toast = useAppToast();
  const [pending, guard] = useSubmitGuard();
  const [failure, setFailure] = useState<Failure | null>(null);
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

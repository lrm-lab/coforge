import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import type { AgentWakeBlock } from "#src/server/agents/agent-wake-block.server";
import type { AgentRetry } from "./agent-error-banner";

const TEXT: Record<AgentWakeBlock["reason"], (count: number) => string> = {
  stopped: (count) => m.agent_wake_block_stopped({ count }),
  start_failed: (count) => m.agent_wake_block_start_failed({ count }),
  operation_in_flight: (count) => m.agent_wake_block_in_flight({ count }),
};

export function AgentWakeBlockNote({
  block,
  retry,
}: {
  block: AgentWakeBlock;
  retry?: Pick<AgentRetry, "onRetry" | "busy" | "deferred" | "note">;
}) {
  const action = block.reason === "operation_in_flight" ? undefined : retry;
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-secondary px-5 py-2.5 text-sm"
    >
      <span className="text-secondary">{TEXT[block.reason](block.messageCount)}</span>
      {action && (
        <Button
          color="link-gray"
          size="sm"
          className="*:data-text:decoration-fg-quaternary *:data-text:underline-offset-2"
          isDisabled={action.busy}
          onPress={action.onRetry}
        >
          {action.busy && !action.deferred
            ? m.agent_control_start_pending()
            : m.agent_control_start()}
        </Button>
      )}
      {action?.note && <span className="text-tertiary">{action.note}</span>}
    </div>
  );
}

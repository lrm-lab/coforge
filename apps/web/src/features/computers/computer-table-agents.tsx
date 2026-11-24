import { ActorAvatarStack, AVATAR_STACK_LIMIT } from "#src/features/avatars/actor-avatar-stack";
import { AVATAR_STACK_RING } from "#src/features/avatars/avatar-stack-ring";
import { m } from "#src/paraglide/messages";
import { ComputerCardAgentChip } from "./computer-card";
import type { ComputerOverviewItem } from "./computer-overview-model";

export const COMPUTER_TABLE_MAX_VISIBLE_AGENTS = AVATAR_STACK_LIMIT;
export const COMPUTER_TABLE_COMPACT_OVERFLOW_VISIBLE_AGENTS = 2;

export function computerTableVisibleAgentCount(total: number, compact: boolean): number {
  if (total <= 0) return 0;
  if (!compact) return Math.min(total, COMPUTER_TABLE_MAX_VISIBLE_AGENTS);
  if (total <= COMPUTER_TABLE_MAX_VISIBLE_AGENTS) return total;
  if (total - COMPUTER_TABLE_COMPACT_OVERFLOW_VISIBLE_AGENTS >= 1000) return 1;
  return COMPUTER_TABLE_COMPACT_OVERFLOW_VISIBLE_AGENTS;
}

export function ComputerTableAgentsCell({
  agents,
  compact,
}: {
  agents: ComputerOverviewItem["agents"];
  compact: boolean;
}) {
  if (agents.length === 0) {
    return (
      <div className="hidden min-w-0 items-center md:flex">
        <span className="text-xs text-quaternary">—</span>
      </div>
    );
  }

  const visibleCount = computerTableVisibleAgentCount(agents.length, compact);
  const shown = agents.slice(0, visibleCount);
  const more = agents.length - shown.length;

  return (
    <div className="hidden min-w-0 items-center md:flex">
      <ActorAvatarStack
        more={more}
        moreLabel={more > 0 ? `+${more}` : undefined}
        aria-label={m.computer_overview_agents_count({ count: agents.length })}
        className="relative z-10 inline-flex max-w-full"
      >
        {shown.map((agent) => (
          <ComputerCardAgentChip
            key={agent.id}
            agent={agent}
            avatarClassName={AVATAR_STACK_RING.outline}
            triggerClassName="z-0 hover:z-10 focus-visible:z-10"
          />
        ))}
      </ActorAvatarStack>
    </div>
  );
}

import { Button as AriaButton } from "react-aria-components";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { TooltipGroup } from "#src/components/ui/tooltip-group";
import { RollingNumber } from "#src/components/ui/rolling-number";
import { ActorName } from "#src/features/avatars/actor-name";
import { cn } from "#src/lib/utils";
import { formatNumber } from "#src/lib/format-number";
import { getLocale } from "#src/paraglide/runtime";
import { useMemberDirectory } from "./member-directory";
import type { ReactionSummary, Reactor } from "./message-reactions";

const MAX_VISIBLE_REACTORS = 8;

function ReactorNames({ reactors }: { reactors: Reactor[] }) {
  const directory = useMemberDirectory();
  const visible = reactors.slice(0, MAX_VISIBLE_REACTORS);
  const overflow = reactors.length - visible.length;
  return (
    <span className="flex max-w-full min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
      {visible.map((reactor, index) => {
        const member = directory?.find((candidate) => candidate.id === reactor.id);
        return (
          <span key={reactor.id} className="inline-flex max-w-full min-w-0 items-center">
            {index > 0 && <span className="me-1 shrink-0">,</span>}
            <ActorName
              actor={{
                kind: member?.kind ?? (reactor.label.startsWith("@") ? "agent" : "user"),
                id: reactor.id,
                name: reactor.label,
                avatarUrl: member?.avatarUrl,
              }}
            />
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="shrink-0 text-tooltip-supporting-text tabular-nums">
          +{formatNumber(overflow, getLocale())}
        </span>
      )}
    </span>
  );
}

export function MessageReactionBadges({
  reactions,
  viewerId,
  onToggle,
}: {
  reactions: ReactionSummary[] | null | undefined;
  viewerId: string | undefined;
  onToggle?: (emoji: string, active: boolean) => void;
}) {
  if (!reactions?.length) return null;
  return (
    <TooltipGroup className="flex flex-wrap gap-1 pt-0.5">
      {reactions.map(({ emoji, count, reactors }) => {
        const mine = viewerId !== undefined && reactors.some((reactor) => reactor.id === viewerId);
        return (
          <Tooltip key={emoji} title={<ReactorNames reactors={reactors} />} placement="top">
            <AriaButton
              aria-label={`${emoji} ${count}`}
              aria-pressed={mine}
              onPress={() => onToggle?.(emoji, !mine)}
              className={cn(
                "inline-flex h-auto cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2",
                mine
                  ? "bg-utility-brand-50 text-utility-brand-700 ring-utility-brand-200 hover:bg-utility-brand-100"
                  : "bg-utility-neutral-50 text-utility-neutral-700 ring-utility-neutral-200 hover:bg-utility-neutral-100",
              )}
            >
              {emoji} <RollingNumber value={count} />
            </AriaButton>
          </Tooltip>
        );
      })}
    </TooltipGroup>
  );
}

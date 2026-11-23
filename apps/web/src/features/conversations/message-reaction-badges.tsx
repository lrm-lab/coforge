import { HoverPopover } from "#src/components/ui/hover-popover";
import { RollingNumber } from "#src/components/ui/rolling-number";
import { cn } from "#src/lib/utils";
import { ActorName } from "#src/features/avatars/actor-name";
import { useMemberDirectory } from "./member-directory";
import type { ReactionSummary, Reactor } from "./message-reactions";

function ReactorNames({ reactors }: { reactors: Reactor[] }) {
  const directory = useMemberDirectory();
  return reactors.map((reactor, index) => {
    const member = directory?.find((candidate) => candidate.id === reactor.id);
    return (
      <span key={reactor.id}>
        {index > 0 && ", "}
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
  });
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
    <div className="flex flex-wrap gap-1 pt-0.5">
      {reactions.map(({ emoji, count, reactors }) => {
        const mine = viewerId !== undefined && reactors.some((reactor) => reactor.id === viewerId);
        return (
          <HoverPopover
            key={emoji}
            label={`${emoji} ${count}`}
            onPress={() => onToggle?.(emoji, !mine)}
            triggerClassName={cn(
              "inline-flex h-auto cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2",
              mine
                ? "bg-utility-brand-50 text-utility-brand-700 ring-utility-brand-200 hover:bg-utility-brand-100"
                : "bg-utility-neutral-50 text-utility-neutral-700 ring-utility-neutral-200 hover:bg-utility-neutral-100",
            )}
            className="w-auto max-w-xs px-3 py-2 text-xs text-secondary"
            trigger={
              <>
                {emoji} <RollingNumber value={count} />
              </>
            }
          >
            <ReactorNames reactors={reactors} />
          </HoverPopover>
        );
      })}
    </div>
  );
}

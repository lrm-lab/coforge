import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { RollingNumber } from "#src/components/ui/rolling-number";
import { cn } from "#src/lib/utils";
import { ActorName } from "#src/features/avatars/actor-name";
import { useMemberDirectory } from "./member-directory";
import type { ReactionSummary, Reactor } from "./message-reactions";

/** Who reacted, each with their face (task #521). The face comes from the conversation's members
 * by id; a reactor who has since left is still named, with an initial in place of a picture. An
 * Agent's label is its `@handle`, which is how the server writes one. */
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

/**
 * A message's reactions, one badge per emoji with its count; hovering names who reacted, and
 * pressing one adds the viewer's reaction or takes it back. A badge counts as mine when a reactor
 * is the viewer, and flips to brand to show it. Renders nothing for a message without reactions.
 */
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
          <Tooltip key={emoji} title={<ReactorNames reactors={reactors} />}>
            <TooltipTrigger>
              <Button
                color="tertiary"
                size="sm"
                noTextPadding
                onPress={() => onToggle?.(emoji, !mine)}
                aria-pressed={mine}
                className={cn(
                  "h-auto rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                  mine
                    ? "bg-utility-brand-50 text-utility-brand-700 ring-utility-brand-200 hover:bg-utility-brand-100"
                    : "bg-utility-neutral-50 text-utility-neutral-700 ring-utility-neutral-200 hover:bg-utility-neutral-100",
                )}
              >
                {emoji} <RollingNumber value={count} />
              </Button>
            </TooltipTrigger>
          </Tooltip>
        );
      })}
    </div>
  );
}

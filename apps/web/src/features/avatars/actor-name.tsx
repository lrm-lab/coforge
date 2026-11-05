import { cn } from "#src/lib/utils";
import { ActorAvatar } from "./actor-avatar";

/** Someone a line names: a person or an Agent, with the picture their face is drawn from. */
export type NamedActor = {
  kind: "user" | "agent";
  /** The User or Agent id: an Agent with no picture of its own gets its mascot from it. */
  id?: string;
  name: string;
  avatarUrl?: string | null;
  deleted?: boolean;
};

/**
 * A name with its face before it, wherever a line names someone (Frank, 11-04, task #521: "只要有
 * 人的地方尽量带上头像"): a 16px face on the name's line, in the text's own size and colour, inline
 * in a sentence or alone. No status dot: the face only says who (task #510). Alone, a long name
 * is cut to its own width. `inline` makes the face and name words of the sentence around them: in
 * a line cut to one, the name is cut with it, letter by letter (a system notice, task #561). Cut
 * whole, the name was one box the line's ellipsis could only drop, so "added @long-name to this
 * channel." read "added …<face>".
 */
export function ActorName({
  actor,
  inline = false,
  className,
}: {
  actor: NamedActor;
  inline?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        inline ? "inline" : "inline-flex max-w-full items-center gap-1 align-bottom",
        className,
      )}
    >
      <ActorAvatar
        presence={false}
        size="xs"
        name={actor.name}
        alt=""
        src={actor.avatarUrl ?? undefined}
        agentId={actor.kind === "agent" ? actor.id : undefined}
        userId={actor.kind === "user" ? actor.id : undefined}
        deleted={actor.deleted}
        // In running text the face is centred on the words' x-height (`vertical-align: middle`),
        // not set off their baseline: the avatar is an inline flex box, whose own baseline each
        // engine derives from its picture differently, so an offset from it sat the face low.
        className={cn("size-4 shrink-0", inline && "mr-1 align-middle")}
      />
      <span className={inline ? undefined : "truncate"}>{actor.name}</span>
    </span>
  );
}

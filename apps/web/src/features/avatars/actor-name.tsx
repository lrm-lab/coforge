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
 * in a sentence or alone. No status dot: the face only says who (task #510). A long name is cut
 * to its line; with `wrap` it runs on over the next lines instead, as the sentence around it does
 * (a card's "Waiting for …", task #554).
 */
export function ActorName({
  actor,
  wrap = false,
  className,
}: {
  actor: NamedActor;
  wrap?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        wrap ? "inline" : "inline-flex max-w-full items-center gap-1 align-bottom",
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
        className={cn("size-4 shrink-0", wrap && "mr-1 align-[-0.1875rem]")}
      />
      <span className={wrap ? undefined : "truncate"}>{actor.name}</span>
    </span>
  );
}

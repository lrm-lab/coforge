import { DELETED_AGENT_NAME_CLASS } from "#src/features/agents/deleted-agent";
import { cn } from "#src/lib/utils";
import { ActorAvatar } from "./actor-avatar";

export type NamedActor = {
  kind: "user" | "agent";
  id?: string;
  name: string;
  avatarUrl?: string | null;
  deleted?: boolean;
};

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
        className={cn("size-4 shrink-0", inline && "mr-1 align-middle")}
      />
      <span className={cn(!inline && "truncate", actor.deleted && DELETED_AGENT_NAME_CLASS)}>
        {actor.name}
      </span>
    </span>
  );
}

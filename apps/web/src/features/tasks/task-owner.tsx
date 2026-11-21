import type { TaskView } from "@lrm/coforge-sdk/internal";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { DELETED_AGENT_NAME_CLASS } from "#src/features/agents/deleted-agent";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function TaskPerson({
  person,
  className,
  wrap,
}: {
  wrap?: boolean;
  person: {
    name: string;
    avatarUrl?: string | null;
    deleted?: boolean;
    kind?: "user" | "agent";
    id?: string;
  };
  className?: string;
}) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-2 text-sm font-medium text-primary", className)}
    >
      <ActorAvatar
        presence={false}
        size="xs"
        name={person.name}
        alt=""
        src={person.avatarUrl ?? undefined}
        deleted={person.deleted}
        {...faceOf(person)}
      />
      <span
        className={cn(
          wrap ? "min-w-0 text-left break-words [[data-layout=chips]_&]:truncate" : "truncate",
          person.deleted && DELETED_AGENT_NAME_CLASS,
        )}
      >
        {person.name}
      </span>
    </span>
  );
}

export function TaskOwnerAvatar({
  owner,
  showName = false,
}: {
  owner: TaskView["owner"];
  showName?: boolean;
}) {
  const name = owner?.name ?? m.tasks_unassigned();
  return (
    <span className={cn("flex items-center gap-1.5", showName ? "min-w-0" : "shrink-0")}>
      <span className="sr-only">
        {m.tasks_overview_owner()}: {name}
      </span>
      <span aria-hidden="true" className="flex">
        {owner ? (
          <ActorAvatar
            presence={false}
            size="xs"
            name={owner.name}
            alt=""
            src={owner.avatarUrl ?? undefined}
            deleted={owner.deleted}
            {...faceOf(owner)}
          />
        ) : (
          <span className="size-6 shrink-0 rounded-full border border-dashed border-primary" />
        )}
      </span>
      {showName && owner && (
        <span
          aria-hidden="true"
          className={cn(
            "min-w-0 truncate text-xs",
            owner.deleted ? DELETED_AGENT_NAME_CLASS : "text-secondary",
          )}
        >
          {owner.name}
        </span>
      )}
    </span>
  );
}

const faceOf = (person: { kind?: "user" | "agent"; id?: string }) =>
  person.kind === "agent" ? { agentId: person.id } : { userId: person.id };

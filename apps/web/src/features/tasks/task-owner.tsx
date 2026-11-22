import type { TaskView } from "@lrm/coforge-sdk/internal";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
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
        dir="auto"
        className={cn(
          wrap ? "min-w-0 text-start break-words [[data-layout=chips]_&]:truncate" : "truncate",
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
  tooltip = false,
}: {
  owner: TaskView["owner"];
  showName?: boolean;
  tooltip?: boolean;
}) {
  const name = owner?.name ?? m.tasks_unassigned();
  const label = `${m.tasks_overview_owner()}: ${name}`;
  const content = (
    <span className={cn("flex items-center gap-1.5", showName ? "min-w-0" : "shrink-0")}>
      {!tooltip && <span className="sr-only">{label}</span>}
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
          dir="auto"
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
  if (!tooltip) return content;
  return (
    <Tooltip title={label}>
      <TooltipTrigger
        aria-label={label}
        className="relative inline-flex shrink-0 rounded-full outline-focus-ring focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-2"
      >
        {content}
      </TooltipTrigger>
    </Tooltip>
  );
}

const faceOf = (person: { kind?: "user" | "agent"; id?: string }) =>
  person.kind === "agent" ? { agentId: person.id } : { userId: person.id };

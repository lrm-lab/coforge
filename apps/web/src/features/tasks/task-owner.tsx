import type { TaskView } from "@lrm/coforge-sdk/internal";

import { IdentityAvatar } from "#src/features/agents/avatar-sticker";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/** An avatar and name, as cards show the owner and the popup shows the assignee and creator. */
export function TaskPerson({
  person,
  className,
}: {
  person: { name: string; avatarUrl?: string | null; deleted?: boolean };
  className?: string;
}) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-2 text-sm font-medium text-primary", className)}
    >
      <IdentityAvatar
        size="xs"
        initials={person.name.trim().charAt(0).toUpperCase()}
        alt=""
        src={person.avatarUrl ?? undefined}
        deleted={person.deleted}
      />
      <span className="truncate">{person.name}</span>
      {/* A Task's holder can be a deleted Agent: its Tasks stay readable, so the card says the
          identity is gone rather than reading as a live owner. */}
      {person.deleted && <DeletedAgentBadge />}
    </span>
  );
}

/** The owner as an avatar alone (its name for assistive tech), as list rows and board cards
 * show it; no owner is a dashed ring. A deleted Agent keeps its greyed avatar and its ARCHIVED
 * marker, as everywhere a Task names its holder. No tooltip: its trigger would add a tab stop to
 * every card. */
export function TaskOwnerAvatar({ owner }: { owner: TaskView["owner"] }) {
  const name = owner?.name ?? m.tasks_unassigned();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="sr-only">
        {m.tasks_overview_owner()}: {name}
      </span>
      <span aria-hidden="true" className="flex">
        {owner ? (
          <IdentityAvatar
            size="xs"
            initials={owner.name.trim().charAt(0).toUpperCase()}
            alt=""
            src={owner.avatarUrl ?? undefined}
            deleted={owner.deleted}
          />
        ) : (
          <span className="size-6 shrink-0 rounded-full border border-dashed border-primary" />
        )}
      </span>
      {owner?.deleted && <DeletedAgentBadge />}
    </span>
  );
}

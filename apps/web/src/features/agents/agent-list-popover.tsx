import { useState, type ReactNode, type Ref } from "react";
import { Dialog as AriaDialog, Popover as AriaPopover } from "react-aria-components";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";

import { AgentDisplayAvatar } from "./agent-display-avatar";
import type { AgentMascot } from "./agent-mascot";
import { AgentMascotAvatar } from "./agent-mascot-avatar";

/**
 * The popover a header control opens with a list of Agents (the thread's following Agents, the
 * chat list header's busy ones): its enter and exit motion, width, and a dialog labelled `label`.
 * `children` receives `close`, to close the popover when a row opens a profile. `dialogRef` reaches
 * the dialog, which a row that leaves the list can hand focus to.
 */
export function AgentListPopover({
  label,
  dialogRef,
  children,
}: {
  label: string;
  dialogRef?: Ref<HTMLElement>;
  children: (close: () => void) => ReactNode;
}) {
  return (
    <AriaPopover
      placement="bottom end"
      offset={8}
      className={cn(
        "origin-(--trigger-anchor-point) overflow-hidden rounded-lg bg-primary shadow-lg ring-1 ring-secondary_alt will-change-transform",
        POPOVER_MOTION,
        "w-[min(20rem,calc(100vw-2.5rem))]",
      )}
    >
      <AriaDialog ref={dialogRef} aria-label={label} className="outline-hidden">
        {({ close }) => children(close)}
      </AriaDialog>
    </AriaPopover>
  );
}

/** The scrolling list of `AgentListRow`s inside an `AgentListPopover`. */
export function AgentListRows({ children }: { children: ReactNode }) {
  return (
    <ul className="max-h-72 divide-y divide-secondary overflow-y-auto py-1 [scrollbar-width:thin]">
      {children}
    </ul>
  );
}

/**
 * One Agent in an `AgentListPopover`: its avatar with status dot and name, with a muted `caption`
 * line under the name when given. With a `mascot` the avatar is the moving one, acting out
 * `display` and reacting to the pointer over the row; without one it stays the still picture.
 * With `onOpenProfile` the identity is a button that opens the Agent's profile; `action` is a
 * control after it (unfollow).
 */
export function AgentListRow({
  agentId,
  name,
  src,
  mascot,
  display,
  caption,
  onOpenProfile,
  action,
}: {
  agentId: string;
  name: string;
  src?: string | null;
  mascot?: AgentMascot;
  display?: AgentDisplaySnapshot;
  caption?: string;
  onOpenProfile?: () => void;
  action?: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const identity = (
    <>
      {mascot ? (
        <AgentMascotAvatar
          mascot={mascot}
          name={name}
          display={display}
          cornerDot
          announced
          hovered={hovered}
        />
      ) : (
        <AgentDisplayAvatar agentId={agentId} name={name} src={src} display={display} size="sm" />
      )}
      {caption ? (
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="truncate text-sm font-medium text-primary">{name}</span>
          <span className="truncate text-xs font-normal text-tertiary">{caption}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate text-sm font-medium text-primary">{name}</span>
      )}
    </>
  );
  return (
    <li
      className="flex items-center gap-2 px-3 py-2"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {onOpenProfile ? (
        <Button
          color="tertiary"
          noTextPadding
          aria-label={m.agent_open_profile({ name })}
          onPress={onOpenProfile}
          // Base Button wraps children in an inline `span[data-text]`; without this the
          // block-level avatar forces the name onto its own line (and drags the status
          // dot to the row's right edge). Make the wrapper the flex row instead.
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded p-0 hover:bg-transparent [&>[data-text]]:flex [&>[data-text]]:min-w-0 [&>[data-text]]:flex-1 [&>[data-text]]:items-center [&>[data-text]]:gap-2"
        >
          {identity}
        </Button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
      )}
      {action}
    </li>
  );
}

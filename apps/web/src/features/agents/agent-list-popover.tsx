import type { ReactNode } from "react";
import { Dialog as AriaDialog, Popover as AriaPopover } from "react-aria-components";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

import { AgentDisplayAvatar } from "./agent-display-avatar";

/**
 * The popover a header control opens with a list of Agents (the thread's following Agents, the
 * chat list header's busy ones): its enter and exit motion, width, and a dialog labelled `label`.
 * `children` receives `close`, to close the popover when a row opens a profile.
 */
export function AgentListPopover({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  return (
    <AriaPopover
      placement="bottom end"
      offset={8}
      className={(state) =>
        cn(
          "origin-(--trigger-anchor-point) overflow-hidden rounded-lg bg-primary shadow-lg ring-1 ring-secondary_alt will-change-transform",
          state.isEntering &&
            "duration-150 ease-out animate-in fade-in placement-bottom:slide-in-from-top-0.5",
          state.isExiting &&
            "duration-100 ease-in animate-out fade-out placement-bottom:slide-out-to-top-0.5",
          "w-[min(20rem,calc(100vw-2.5rem))]",
        )
      }
    >
      <AriaDialog aria-label={label} className="outline-hidden">
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
 * line under the name when given. With `onOpenProfile` the identity is a button that opens the
 * Agent's profile; `action` is a control after it (unfollow).
 */
export function AgentListRow({
  agentId,
  name,
  src,
  display,
  caption,
  onOpenProfile,
  action,
}: {
  agentId: string;
  name: string;
  src?: string | null;
  display?: AgentDisplaySnapshot;
  caption?: string;
  onOpenProfile?: () => void;
  action?: ReactNode;
}) {
  const identity = (
    <>
      <AgentDisplayAvatar agentId={agentId} name={name} src={src} display={display} size="sm" />
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
    <li className="flex items-center gap-2 px-3 py-2">
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

import { useState } from "react";
import { CheckCircle } from "@untitledui/icons";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import {
  FLOATING_SURFACE_CLASS,
  SECTION_LABEL_CLASS,
} from "#src/features/conversations/review-chrome";
import { messageSlots } from "#src/lib/message-slots";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import type {
  ArtifactReopenedView,
  ArtifactSettledView,
  ArtifactSettlementState,
} from "./use-artifact-settlement";

type SettledRecord = NonNullable<ArtifactSettledView>;

const SETTLED_PILL_SURFACE =
  "bg-utility-green-50 text-utility-green-700 ring-1 ring-utility-green-200 ring-inset";

function useSettlementActorAvatar(actor: SettledRecord["by"]) {
  const { data } = useWorkspaceDirectory();
  if (!data) return {};
  if (actor.kind === "agent") {
    const found = data.agents.find(
      (agent) => agent.name === actor.name || agent.handle === actor.name,
    );
    return found ? { agentId: found.id, src: found.avatarUrl } : {};
  }
  const found = data.people.find((person) => person.name === actor.name);
  return found ? { userId: found.id, src: found.avatarUrl ?? undefined } : {};
}

export function SettledBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span
      data-artifact-settled-badge=""
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium",
        SETTLED_PILL_SURFACE,
        className,
      )}
    >
      <CheckCircle aria-hidden="true" className="size-3 shrink-0 text-utility-green-500" />
      <span>{label}</span>
    </span>
  );
}

function ArtifactSettlementPopoverContent({
  settled,
  pending,
  placement,
  onUnsettle,
  onClose,
}: {
  settled: SettledRecord;
  pending: boolean;
  placement: "bottom end" | "bottom start";
  onUnsettle: () => Promise<boolean>;
  onClose: () => void;
}) {
  const avatar = useSettlementActorAvatar(settled.by);
  const title = m.av_settled_title({ version: settled.version });
  const handleUnsettle = async () => {
    if (await onUnsettle()) onClose();
  };

  return (
    <Popover
      placement={placement}
      className={cn(
        "w-72 max-w-[calc(100vw-1.5rem)] origin-(--trigger-anchor-point) p-3",
        FLOATING_SURFACE_CLASS,
        POPOVER_MOTION,
      )}
    >
      <Dialog aria-label={title} className="flex flex-col outline-hidden">
        <div className="flex items-center justify-between gap-2">
          <SettledBadge label={title} />
        </div>
        <div className="mt-2.5 flex items-center gap-2 text-xs text-secondary">
          <ActorAvatar
            presence={false}
            size="xs"
            name={settled.by.name}
            agentId={avatar.agentId}
            src={avatar.src}
            className="size-5 shrink-0"
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {messageSlots(m.av_settled_by, {
              name: settled.by.name,
              time: <RelativeTime value={settled.at} plain />,
            })}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-tertiary">{m.av_settled_hint()}</p>
        <div className="mt-3 border-t border-secondary pt-2.5">
          <Button
            size="sm"
            color="secondary"
            className="w-full"
            isLoading={pending}
            isDisabled={pending}
            onPress={() => void handleUnsettle()}
          >
            {m.av_unsettle_action()}
          </Button>
        </div>
      </Dialog>
    </Popover>
  );
}

export function ArtifactSettlementHeaderControl({
  settlement,
}: {
  settlement: ArtifactSettlementState;
}) {
  const [open, setOpen] = useState(false);

  if (!settlement.settled) {
    return (
      <AriaButton
        data-artifact-settle=""
        isDisabled={settlement.pending}
        onPress={() => void settlement.settle()}
        className="relative flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 max-sm:hidden"
      >
        <CheckCircle aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
        <span>{m.av_settle_action()}</span>
      </AriaButton>
    );
  }

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <AriaButton
        data-artifact-settled=""
        className={cn(
          "relative flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-focus-ring transition-colors duration-150 hover:bg-utility-green-100 focus-visible:outline-2 focus-visible:outline-offset-2 max-sm:hidden",
          SETTLED_PILL_SURFACE,
        )}
      >
        <CheckCircle aria-hidden="true" className="size-3.5 shrink-0 text-utility-green-500" />
        <span>{m.av_settled_badge()}</span>
      </AriaButton>
      <ArtifactSettlementPopoverContent
        settled={settlement.settled}
        pending={settlement.pending}
        placement="bottom end"
        onUnsettle={settlement.unsettle}
        onClose={() => setOpen(false)}
      />
    </DialogTrigger>
  );
}

export function ArtifactSettlementMobileChip({
  settlement,
}: {
  settlement: ArtifactSettlementState;
}) {
  const [open, setOpen] = useState(false);
  if (!settlement.settled) return null;

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <AriaButton
        data-artifact-settled-mobile=""
        className={cn(
          "relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs font-medium outline-focus-ring transition-colors duration-150 hover:bg-utility-green-100 focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-x-1.5 any-pointer-coarse:after:-inset-y-2.5",
          SETTLED_PILL_SURFACE,
        )}
      >
        <CheckCircle aria-hidden="true" className="size-3 shrink-0 text-utility-green-500" />
        <span>{m.av_settled_badge()}</span>
      </AriaButton>
      <ArtifactSettlementPopoverContent
        settled={settlement.settled}
        pending={settlement.pending}
        placement="bottom start"
        onUnsettle={settlement.unsettle}
        onClose={() => setOpen(false)}
      />
    </DialogTrigger>
  );
}

export function ArtifactSettlementDetailsSection({
  settled,
  reopened,
  latestVersion,
}: {
  settled: ArtifactSettledView;
  reopened: ArtifactReopenedView;
  latestVersion: number;
}) {
  return (
    <section data-artifact-details-status="" className="flex flex-col gap-1 p-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className={SECTION_LABEL_CLASS}>{m.av_details_status()}</span>
        {settled ? (
          <SettledBadge label={m.av_settled_title({ version: settled.version })} />
        ) : (
          <span className="text-xs text-tertiary tabular-nums">
            {m.av_details_working()} · v{latestVersion}
          </span>
        )}
      </div>
      <p className="px-1 text-xs leading-relaxed text-quaternary [overflow-wrap:anywhere]">
        {settled
          ? messageSlots(m.av_settled_by, {
              name: settled.by.name,
              time: <RelativeTime value={settled.at} plain />,
            })
          : reopened
            ? m.av_reopened_banner({
                version: reopened.version,
                name: reopened.was.by.name,
                settledVersion: reopened.was.version,
              })
            : m.av_details_latest_version({ version: latestVersion })}
      </p>
    </section>
  );
}

export function ArtifactReopenedBanner({
  reopened,
  pending,
  onSettle,
}: {
  reopened: NonNullable<ArtifactReopenedView>;
  pending: boolean;
  onSettle: () => Promise<boolean>;
}) {
  return (
    <div
      data-artifact-reopened-banner=""
      className="mx-3 mt-3 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-secondary bg-secondary px-3 py-2 text-xs sm:mx-4"
    >
      <span className="min-w-0 flex-1 leading-snug text-secondary [overflow-wrap:anywhere]">
        {m.av_reopened_banner({
          version: reopened.version,
          name: reopened.was.by.name,
          settledVersion: reopened.was.version,
        })}
      </span>
      <Button
        size="xs"
        color="secondary"
        isLoading={pending}
        isDisabled={pending}
        onPress={() => void onSettle()}
        className="shrink-0"
      >
        {m.av_settle_again()}
      </Button>
    </div>
  );
}

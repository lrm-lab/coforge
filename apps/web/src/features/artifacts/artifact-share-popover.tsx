import { useState } from "react";
import { Check, Code01, Link01, LinkBroken01, Send01, Share01 } from "@untitledui/icons";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import {
  FLOATING_SURFACE_CLASS,
  SECTION_LABEL_CLASS,
} from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import { visibilityIcon, type VisibilityChoice } from "./artifact-scope";
import { visibilityChoiceLabel, type ArtifactVisibility } from "./use-artifact-visibility";

export function ArtifactSharePopover({
  visibility,
  onCopyLink,
  onSend,
  onEmbed,
}: {
  visibility: ArtifactVisibility;
  onCopyLink: () => void;
  onSend: () => void;
  onEmbed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { current, canChange, narrowable, linkAvailable, legacyLinkActive } = visibility;
  const choices = (["conversation", "workspace", "link"] as const).filter(
    (choice) =>
      choice === current ||
      (canChange &&
        (choice !== "link" || linkAvailable) &&
        (choice !== "conversation" || narrowable)),
  );
  const choose = (choice: VisibilityChoice) => {
    if (!canChange || choice === current) return;
    visibility.request(choice);
    setOpen(false);
  };

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Tooltip title={m.av_share()} isDisabled={open}>
        <AriaButton
          data-artifact-share=""
          aria-label={m.av_share()}
          className={cn(
            "relative flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-focus-ring transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 max-sm:w-8 max-sm:px-0 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5",
            open
              ? "bg-tertiary text-primary"
              : "text-fg-quaternary hover:bg-primary_hover hover:text-secondary",
          )}
        >
          <Share01 aria-hidden="true" className="size-4 shrink-0" />
          <span className="max-sm:hidden">{m.av_share()}</span>
        </AriaButton>
      </Tooltip>
      <Popover
        placement="bottom end"
        className={cn(
          "flex w-72 max-w-[calc(100vw-1.5rem)] origin-(--trigger-anchor-point) flex-col",
          FLOATING_SURFACE_CLASS,
          POPOVER_MOTION,
        )}
      >
        <Dialog aria-label={m.av_share()} className="flex flex-col outline-hidden">
          <section className="p-3">
            <h3 className={cn(SECTION_LABEL_CLASS, "mb-1.5 px-1")}>{m.av_who_can_see()}</h3>
            <div className="flex flex-col gap-0.5">
              {choices.map((choice) => {
                const Icon = visibilityIcon[choice];
                const selected = choice === current;
                const displayLabel = visibilityChoiceLabel(visibility, choice);
                if (!canChange) {
                  return (
                    <div
                      key={choice}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-secondary"
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                      <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
                    </div>
                  );
                }
                return (
                  <AriaButton
                    key={choice}
                    onPress={() => choose(choice)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2",
                      selected ? "bg-tertiary font-medium text-primary" : "text-secondary",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                    <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
                    {selected && (
                      <Check aria-hidden="true" className="size-4 shrink-0 text-fg-brand-primary" />
                    )}
                  </AriaButton>
                );
              })}
              {canChange && legacyLinkActive && (
                <AriaButton
                  onPress={() => {
                    visibility.revokeLegacyLink();
                    setOpen(false);
                  }}
                  className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2"
                >
                  <LinkBroken01 aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{m.av_vis_link_off_confirm()}</span>
                </AriaButton>
              )}
            </div>
          </section>
          <div className="flex items-center justify-between gap-2 border-t border-secondary p-2.5">
            <AriaButton
              onPress={() => {
                setOpen(false);
                onSend();
              }}
              className="flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-secondary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-primary focus-visible:outline-2"
            >
              <Send01 aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
              <span className="truncate">{m.doc_send_action()}</span>
            </AriaButton>
            <div className="flex shrink-0 items-center gap-1">
              {visibility.canEmbed && (
                <ButtonUtility
                  icon={Code01}
                  size="xs"
                  color="tertiary"
                  tooltip={m.av_menu_embed()}
                  className="size-8"
                  onClick={() => {
                    setOpen(false);
                    onEmbed();
                  }}
                />
              )}
              <AriaButton
                onPress={() => {
                  setOpen(false);
                  onCopyLink();
                }}
                className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-alpha-black px-3 text-xs font-medium text-alpha-white outline-focus-ring transition-opacity duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <Link01 aria-hidden="true" className="size-3.5 shrink-0" />
                <span>{m.doc_copy_link()}</span>
              </AriaButton>
            </div>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

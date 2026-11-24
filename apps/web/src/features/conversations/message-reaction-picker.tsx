import { useEffect, useRef, useState, type ComponentProps } from "react";
import { FaceSmile } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { EmojiPicker } from "#src/components/ui/emoji-picker";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export const QUICK_REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "🔥", "😂", "✅"] as const;

export function FaceSmilePlus({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="M22 12a10 10 0 1 1-10-10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M15.5 9a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0ZM9.5 9a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0Z" />
      <path d="M19 2.5v5M16.5 5h5" />
    </svg>
  );
}

export function MessageReactionPicker({
  onPick,
  start,
  onStarted,
}: {
  onPick: (emoji: string) => void;
  start?: "focus" | "open";
  onStarted?: () => void;
}) {
  const label = m.conversation_add_reaction();
  const moreLabel = m.conversation_more_reactions();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!start) return;
    triggerRef.current?.focus();
    if (start === "open") setIsOpen(true);
    onStarted?.();
  }, [start, onStarted]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setExpanded(false);
      queueMicrotask(() => {
        if (document.activeElement === document.body) {
          triggerRef.current?.focus();
        }
      });
    }
  };

  const pickAndClose = (emoji: string, close: () => void) => {
    onPick(emoji);
    close();
  };

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={handleOpenChange}>
      <ButtonUtility
        ref={triggerRef}
        icon={FaceSmile}
        size="xs"
        color="tertiary"
        tooltip={label}
        aria-label={label}
        className="p-1 *:data-icon:size-3.5"
      />
      <AriaPopover
        placement="top start"
        offset={8}
        data-message-actions-popover
        className={cx(
          "rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none",
          expanded ? "max-w-[calc(100vw-1rem)] overflow-hidden" : "p-1.5",
        )}
      >
        <Dialog ref={dialogRef} aria-label={expanded ? moreLabel : label} className="outline-none">
          {({ close }) =>
            expanded ? (
              <div className="w-88 max-w-[calc(100vw-1rem)]">
                <EmojiPicker onPick={(emoji) => pickAndClose(emoji, close)} />
              </div>
            ) : (
              <div role="group" aria-label={label} className="flex items-center gap-0.5">
                {QUICK_REACTION_EMOJIS.map((emoji) => (
                  <Button
                    key={emoji}
                    color="tertiary"
                    size="sm"
                    noTextPadding
                    onPress={() => pickAndClose(emoji, close)}
                    className="h-auto rounded-md p-1 text-xl leading-none"
                  >
                    {emoji}
                  </Button>
                ))}
                <ButtonUtility
                  icon={FaceSmilePlus}
                  size="xs"
                  color="tertiary"
                  tooltip={moreLabel}
                  aria-label={moreLabel}
                  onClick={() => {
                    setExpanded(true);
                    queueMicrotask(() => dialogRef.current?.focus());
                  }}
                  className="size-7 rounded-md p-1 *:data-icon:size-5"
                />
              </div>
            )
          }
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}

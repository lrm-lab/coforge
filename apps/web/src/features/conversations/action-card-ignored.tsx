import { SlashCircle01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/**
 * What an ignored card becomes, one row in its place (Frank, task #91: the stream moves once): a
 * slash, "Ignored" and the card's question, and Undo while the ignore can still be undone. Once it
 * is final the row stays as it is, its Undo fading out where it was, so nothing below moves again.
 */
export function IgnoredLine({
  title,
  onUndo,
  final,
}: {
  title: string;
  onUndo: () => void;
  /** The five seconds are over and the card is cancelled: nothing left to undo. */
  final: boolean;
}) {
  return (
    <div className="flex h-8 items-center gap-2 px-2.5" data-ignored-line="">
      <SlashCircle01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
      <p className="min-w-0 flex-1 truncate text-sm text-tertiary">
        {m.action_card_ignored_short()}
        {title && <span className="text-quaternary"> · {title}</span>}
      </p>
      <Button
        data-ignore-undo=""
        size="sm"
        color="link-gray"
        onPress={onUndo}
        isDisabled={final}
        aria-hidden={final || undefined}
        className={cn(
          "shrink-0 transition-opacity motion-leave motion-reduce:transition-none",
          final && "invisible opacity-0",
        )}
      >
        {m.action_card_undo()}
      </Button>
    </div>
  );
}

/** Moves focus to the card's Undo (just collapsed) or its Ignore button (back, by undo or failure). */
export function focusIgnore(card: HTMLElement | null, to: "undo" | "ignore") {
  // Without scrolling: the button sits in a fold still opening, whose clipped box would scroll.
  card
    ?.querySelector<HTMLElement>(to === "undo" ? "[data-ignore-undo]" : "[data-ignore]")
    ?.focus({ preventScroll: true });
}

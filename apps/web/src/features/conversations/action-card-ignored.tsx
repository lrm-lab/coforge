import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

/** What an ignored card shows under its title while the ignore can still be undone. */
export function IgnoredLine({ onUndo }: { onUndo: () => void }) {
  return (
    <div className="flex items-center gap-3 px-2.5 pb-1">
      <p className="min-w-0 flex-1 text-sm text-tertiary">{m.action_card_ignored()}</p>
      <Button data-ignore-undo="" size="sm" color="link-gray" onPress={onUndo}>
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

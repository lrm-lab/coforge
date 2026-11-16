import { useRef } from "react";
import { Button } from "#src/components/base/buttons/button";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useQuestionDock, type DockCard } from "./question-card-host";

/**
 * "Not answering" (Frank, 11-12): it tells the Agent and cannot be taken back, so it asks once,
 * anchored where it was pressed; Cancel, Escape and a click outside go back with nothing sent. On
 * a desktop it sits in the dock's top bar; on a phone, at the foot's empty left, away from the
 * close button a thumb would share.
 */
export function DockDecline({ card, place }: { card: DockCard; place: "top" | "foot" }) {
  const dock = useQuestionDock()!;
  const name = card.message.senderName;
  // The dock this link sits in, which outlives it (another pane may show a dock too).
  const dockRef = useRef<Element | null>(null);
  return (
    <span
      ref={(element) => {
        if (element) dockRef.current = element.closest("[data-question-dock]");
      }}
      className={cn("flex shrink-0", place === "top" ? "max-sm:hidden" : "sm:hidden")}
    >
      <Popconfirm
        title={m.dock_decline_title()}
        description={m.dock_decline_body({ name })}
        confirmLabel={m.dock_decline()}
        pendingLabel={m.dock_sending()}
        errorMessage={m.dock_send_failed()}
        placement={place === "top" ? "bottom end" : "top start"}
        // Declined, the dock turns to its receipt and this link is gone: focus goes to this dock's.
        fallbackFocus={() =>
          dockRef.current?.querySelector<HTMLElement>("[data-dock-receipt]") ?? null
        }
        onConfirm={() => dock.decline(card)}
      >
        <Button data-dock-decline="" size="sm" color="link-gray" className="px-2">
          {m.dock_decline()}
        </Button>
      </Popconfirm>
    </span>
  );
}

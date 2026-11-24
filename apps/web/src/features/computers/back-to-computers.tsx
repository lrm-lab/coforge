import { createContext, useContext } from "react";
import { ChevronLeft, Maximize02, Minimize02, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

export const BackToComputersContext = createContext<(() => void) | undefined>(undefined);

export type ComputerDetailPaneControls = {
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
};

export const ComputerDetailPaneContext = createContext<ComputerDetailPaneControls | undefined>(
  undefined,
);

export function BackToComputers() {
  const back = useContext(BackToComputersContext);
  if (!back) {
    return null;
  }

  return (
    <ButtonUtility
      color="tertiary"
      size="sm"
      onClick={back}
      aria-label={m.computer_back_to_list()}
      className="-ms-2 size-11 shrink-0 md:hidden [&_svg]:rtl:rotate-180"
      icon={ChevronLeft}
    />
  );
}

export function ComputerDetailPaneActions() {
  const pane = useContext(ComputerDetailPaneContext);
  if (!pane) return null;
  return (
    <div className="hidden shrink-0 items-center gap-0.5 md:flex">
      <ButtonUtility
        color="tertiary"
        size="sm"
        icon={pane.expanded ? Minimize02 : Maximize02}
        tooltip={pane.expanded ? m.computer_detail_collapse() : m.computer_detail_expand()}
        className={
          pane.expanded
            ? "bg-secondary text-primary hover:bg-secondary_hover hover:text-primary"
            : undefined
        }
        onClick={pane.onToggleExpand}
      />
      <ButtonUtility
        color="tertiary"
        size="sm"
        icon={XClose}
        tooltip={m.computer_detail_close()}
        onClick={pane.onClose}
      />
    </div>
  );
}

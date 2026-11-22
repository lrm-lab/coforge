import { createContext, useContext } from "react";
import { ChevronLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

export const BackToComputersContext = createContext<(() => void) | undefined>(undefined);

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

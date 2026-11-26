import { Settings01 as Settings } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { HEADER_ICON_CLASS } from "./conversation-header-tabs";

export function DirectSettingsToggleButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <ButtonUtility
      icon={Settings}
      size="sm"
      color="tertiary"
      aria-expanded={open}
      className={cn(HEADER_ICON_CLASS, open && "bg-primary_hover")}
      tooltip={m.direct_settings_open()}
      onClick={onToggle}
    />
  );
}

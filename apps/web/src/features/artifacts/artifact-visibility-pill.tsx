import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { CHIP_CLASS, PRESSABLE_CHIP_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { visibilityIcon } from "./artifact-scope";
import {
  VisibilityMenu,
  visibilityChoiceLabel,
  type ArtifactVisibility,
} from "./use-artifact-visibility";

export function VisibilityPill({ visibility }: { visibility: ArtifactVisibility }) {
  const visibleScope = visibility.legacyLinkActive ? "link" : visibility.current;
  const Icon = visibilityIcon[visibleScope];
  const scope = visibilityChoiceLabel(visibility, visibleScope);
  const inner = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{scope}</span>
    </>
  );
  if (!visibility.canChange)
    return (
      <span aria-label={m.av_vis_aria_fixed({ scope })} className={cn(CHIP_CLASS, "max-w-64")}>
        {inner}
      </span>
    );
  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={m.av_vis_aria({ scope })}
        className={cn(
          PRESSABLE_CHIP_CLASS,
          "relative max-w-64 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-x-1.5 any-pointer-coarse:after:-inset-y-2.5",
        )}
      >
        {inner}
      </AriaButton>
      <Dropdown.Popover placement="bottom start">
        <VisibilityMenu visibility={visibility} />
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

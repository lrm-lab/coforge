import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { visibilityIcon } from "./artifact-scope";
import { VisibilityMenu, type ArtifactVisibility } from "./use-artifact-visibility";

const pillClass =
  "flex min-w-0 max-w-64 shrink items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset";

export const pressablePillClass = `${pillClass} cursor-pointer outline-focus-ring hover:bg-primary_hover focus-visible:outline-2`;

export function VisibilityPill({ visibility }: { visibility: ArtifactVisibility }) {
  const Icon = visibilityIcon[visibility.current];
  const scope = visibility.label[visibility.current];
  const inner = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{scope}</span>
    </>
  );
  if (!visibility.canChange)
    return (
      <span aria-label={m.av_vis_aria_fixed({ scope })} className={pillClass}>
        {inner}
      </span>
    );
  return (
    <Dropdown.Root>
      <AriaButton aria-label={m.av_vis_aria({ scope })} className={pressablePillClass}>
        {inner}
      </AriaButton>
      <Dropdown.Popover placement="bottom start">
        <VisibilityMenu visibility={visibility} />
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

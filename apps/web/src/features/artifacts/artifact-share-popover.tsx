import { Check, LinkBroken01 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { SECTION_LABEL_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { visibilityIcon, type VisibilityChoice } from "./artifact-scope";
import type { ArtifactVisibility } from "./use-artifact-visibility";

export function VisibilitySection({
  visibility,
  onClose,
}: {
  visibility: ArtifactVisibility;
  onClose: () => void;
}) {
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
    onClose();
  };
  return (
    <section className="p-3">
      <h3 className={cn(SECTION_LABEL_CLASS, "mb-1.5 px-1")}>{m.av_who_can_see()}</h3>
      <div className="flex flex-col gap-0.5">
        {choices.map((choice) => {
          const Icon = visibilityIcon[choice];
          const selected = choice === current;
          if (!canChange) {
            return (
              <div
                key={choice}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-secondary"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                <span className="min-w-0 flex-1 truncate">{visibility.label[choice]}</span>
              </div>
            );
          }
          return (
            <AriaButton
              key={choice}
              onPress={() => choose(choice)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2",
                selected ? "font-medium text-primary" : "text-secondary",
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
              <span className="min-w-0 flex-1 truncate">{visibility.label[choice]}</span>
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
              onClose();
            }}
            className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2"
          >
            <LinkBroken01 aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{m.av_vis_link_off_confirm()}</span>
          </AriaButton>
        )}
      </div>
    </section>
  );
}

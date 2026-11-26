import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, SearchLg, XClose } from "@untitledui/icons";
import { ToggleButton as AriaToggleButton } from "react-aria-components";
import { Button } from "#src/components/base/buttons/button";
import { styles as buttonStyles } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { TooltipGroup } from "#src/components/ui/tooltip-group";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { FIND_MATCH_CAP } from "./find-in-text";

/**
 * A quiet icon (or, with `iconOnly={false}`, text) toggle matching `Button`'s
 * tertiary look, styled selected/pressed. Shared by the toolbar's
 * wrap/zen toggles and the find bar's "Aa" case-sensitivity toggle so the
 * pressed/hover styling lives in one place.
 */
export const ToolbarToggle = forwardRef<
  HTMLButtonElement,
  {
    isSelected: boolean;
    onChange: (isSelected: boolean) => void;
    "aria-label": string;
    className?: string;
    /** @default true */
    iconOnly?: boolean;
    children: ReactNode;
  }
>(function ToolbarToggle(
  { isSelected, onChange, "aria-label": ariaLabel, className, iconOnly = true, children },
  ref,
) {
  return (
    <AriaToggleButton
      ref={ref}
      aria-label={ariaLabel}
      isSelected={isSelected}
      onChange={onChange}
      data-icon-only={iconOnly ? true : undefined}
      className={cn(
        buttonStyles.common.root,
        buttonStyles.sizes.sm.root,
        buttonStyles.colors.tertiary.root,
        isSelected && "bg-secondary text-primary",
        className,
      )}
    >
      {children}
    </AriaToggleButton>
  );
});

export function FindBar({
  inputRef,
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  matchCount,
  activeMatchIndex,
  onNext,
  onPrevious,
  onClose,
  onKeyDown,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  matchCount: number;
  activeMatchIndex: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      data-find-bar
      onKeyDown={onKeyDown}
      className="absolute top-2 right-5 z-20 flex items-center gap-1 rounded-lg border border-secondary bg-primary p-1 shadow-lg"
    >
      <Input
        ref={inputRef}
        size="sm"
        aria-label={m.project_file_find_placeholder()}
        placeholder={m.project_file_find_placeholder()}
        icon={SearchLg}
        value={query}
        onChange={onQueryChange}
        wrapperClassName="w-48"
      />
      <span
        className={cn(
          "shrink-0 px-1 text-xs tabular-nums",
          matchCount === 0 ? "text-tertiary" : "text-secondary",
        )}
      >
        {formatMatchCount(matchCount, activeMatchIndex)}
      </span>
      <TooltipGroup className="flex items-center gap-0.5">
        <Tooltip title={m.project_file_find_previous()}>
          <Button
            size="sm"
            color="tertiary"
            aria-label={m.project_file_find_previous()}
            iconLeading={ChevronUp}
            isDisabled={matchCount === 0}
            onPress={onPrevious}
          />
        </Tooltip>
        <Tooltip title={m.project_file_find_next()}>
          <Button
            size="sm"
            color="tertiary"
            aria-label={m.project_file_find_next()}
            iconLeading={ChevronDown}
            isDisabled={matchCount === 0}
            onPress={onNext}
          />
        </Tooltip>
        <Tooltip title={m.project_file_find_case()}>
          <ToolbarToggle
            aria-label={m.project_file_find_case()}
            isSelected={caseSensitive}
            onChange={onCaseSensitiveChange}
            iconOnly={false}
            className="px-2 text-xs font-semibold"
          >
            Aa
          </ToolbarToggle>
        </Tooltip>
        <Tooltip title={m.project_file_find_close()}>
          <Button
            size="sm"
            color="tertiary"
            aria-label={m.project_file_find_close()}
            iconLeading={XClose}
            onPress={onClose}
          />
        </Tooltip>
      </TooltipGroup>
    </div>
  );
}

function formatMatchCount(count: number, activeIndex: number): string {
  const total = count >= FIND_MATCH_CAP ? `${FIND_MATCH_CAP.toLocaleString()}+` : String(count);
  const current = count === 0 ? 0 : activeIndex + 1;
  return `${current} / ${total}`;
}

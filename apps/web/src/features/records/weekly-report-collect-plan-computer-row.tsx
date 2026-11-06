import { useEffect, useRef } from "react";
import { Edit01 as Edit, Settings01 as Settings } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { m } from "#src/paraglide/messages";
import type { listWeeklyReportCollectorSlots } from "./records-collect.functions";

type SlotRow = Awaited<ReturnType<typeof listWeeklyReportCollectorSlots>>[number];

/** Selected state uses the same neutral black fill as Records primary buttons. */
const COLLECT_PLAN_CHECKBOX_CLASSNAME =
  "[&[data-selected]>div]:bg-primary-solid! [&[data-selected]>div]:ring-primary-solid!";

export function CollectComputerRow(props: {
  slot: SlotRow;
  checked: boolean;
  pathLines: string[];
  focusedPathIndex: number | null;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
  onEnsure: () => void;
  onConfigure: () => void;
  onPathChange: (index: number, value: string) => void;
  onPathAdd: () => void;
  onPathRemove: (index: number) => void;
  onPathFocused: () => void;
}) {
  const { slot } = props;
  return (
    <div
      className={`rounded-xl border border-secondary p-3 ${props.checked ? "bg-secondary" : "bg-primary"}`}
    >
      <div className="flex items-center gap-2 pl-6">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
          {slot.displayName}
        </span>
        {!slot.ready ? (
          <Button size="sm" color="secondary" isDisabled={props.disabled} onPress={props.onEnsure}>
            {m.records_collect_plan_setup()}
          </Button>
        ) : null}
        {slot.collectorAgentId ? (
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={Settings}
            aria-label={m.records_collect_plan_gear()}
            isDisabled={props.disabled}
            onClick={props.onConfigure}
          />
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Checkbox
          className={`${COLLECT_PLAN_CHECKBOX_CLASSNAME} self-center`}
          isSelected={props.checked}
          isDisabled={props.disabled}
          onChange={(next) => props.onToggle(next)}
        />
        <div className="min-w-0 flex-1 rounded-lg border border-secondary bg-primary px-3 py-1.5">
          {props.pathLines.map((line, index) => (
            <CollectPathRow
              key={`${slot.computerId}-${index}`}
              value={line}
              disabled={props.disabled}
              canRemove={props.pathLines.length > 1}
              autoFocus={props.focusedPathIndex === index}
              onChange={(next) => props.onPathChange(index, next)}
              onAdd={props.onPathAdd}
              onRemove={() => props.onPathRemove(index)}
              onFocused={props.onPathFocused}
            />
          ))}
        </div>
      </div>
      {!slot.ready ? (
        <p className="mt-1 pl-6 text-xs text-warning-primary">
          {m.records_collect_plan_not_ready()}
        </p>
      ) : null}
    </div>
  );
}

function CollectPathRow(props: {
  value: string;
  disabled?: boolean;
  canRemove: boolean;
  autoFocus: boolean;
  onChange: (value: string) => void;
  onAdd: () => void;
  onRemove: () => void;
  onFocused: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.autoFocus) return;
    inputRef.current?.focus();
    props.onFocused();
  }, [props.autoFocus, props.onFocused]);
  return (
    <div className="flex items-center gap-2 py-1">
      <input
        ref={inputRef}
        value={props.value}
        disabled={props.disabled}
        aria-label={m.records_collect_plan_paths()}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (props.disabled || event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            props.onAdd();
            return;
          }
          if (event.key === "Backspace" && props.value === "" && props.canRemove) {
            event.preventDefault();
            props.onRemove();
          }
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-sm text-tertiary outline-none disabled:opacity-60"
      />
      <ButtonUtility
        type="button"
        size="xs"
        color="tertiary"
        icon={Edit}
        aria-label={m.records_collect_plan_paths()}
        isDisabled={props.disabled}
        onClick={() => inputRef.current?.focus()}
      />
    </div>
  );
}

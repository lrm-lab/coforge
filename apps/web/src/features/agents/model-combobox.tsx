import { useContext, useEffect, useMemo, useRef, useState, type Key } from "react";
import { ChevronDown, RefreshCw01 } from "@untitledui/icons";
import { ComboBoxStateContext } from "react-aria-components";

import { ComboBox } from "#src/components/base/select/combobox";
import { SelectItem } from "#src/components/base/select/select-item";
import { m } from "#src/paraglide/messages";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { Spinner } from "#src/components/ui/spinner";
import { searchModelChoices, type ModelChoice } from "./model-search";

const showEverything = () => true;

const REFRESH_KEY = "\u0000refresh";
const EMPTY_KEY = "\u0000empty";

export type ModelListRefresh = { run: () => void; busy: boolean; refreshing: boolean };

function ListToggle({ searching }: { searching: boolean }) {
  const state = useContext(ComboBoxStateContext);
  const latest = useRef({ state, searching });
  latest.current = { state, searching };
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const field = anchor.current?.parentElement;
    const input = field?.querySelector("input");
    if (!field || !input) return;
    let hadFocus = false;
    const down = () => {
      hadFocus = document.activeElement === input;
    };
    const press = () => {
      const { state: combobox, searching } = latest.current;
      if (!hadFocus || !combobox) return;
      if (!combobox.isOpen) combobox.open(null, "manual");
      else if (!searching) combobox.close();
    };
    field.addEventListener("pointerdown", down);
    field.addEventListener("click", press);
    return () => {
      field.removeEventListener("pointerdown", down);
      field.removeEventListener("click", press);
    };
  }, []);
  return (
    <>
      <ChevronDown
        data-icon
        className="pointer-events-none order-last size-4! stroke-[2.25px]"
        aria-hidden="true"
      />
      <span ref={anchor} hidden />
    </>
  );
}

export function ModelComboBox({
  label,
  choices,
  pinned,
  selectedKey,
  onSelectionChange,
  isDisabled,
  className,
  popoverClassName,
  refresh,
}: {
  label: string;
  choices: readonly ModelChoice[];
  pinned: ReadonlySet<string>;
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  isDisabled?: boolean;
  className?: string;
  popoverClassName?: string;
  refresh?: ModelListRefresh;
}) {
  const controlSize = useDialogControlSize();
  const selectedLabel = choices.find((choice) => choice.id === selectedKey)?.label ?? "";
  const [query, setQuery] = useState<string | null>(null);
  const shown = useMemo(() => {
    const matches = searchModelChoices(choices, query ?? "", pinned).map(({ id, label }) => ({
      id,
      label,
    }));
    const trimmed = (query ?? "").trim();
    const emptyRow =
      matches.length === 0
        ? [
            {
              id: EMPTY_KEY,
              label: trimmed
                ? m.empty_model_no_match_query({ query: trimmed })
                : m.empty_picker_no_options(),
            },
          ]
        : [];
    return [
      ...matches,
      ...emptyRow,
      ...(refresh ? [{ id: REFRESH_KEY, label: m.agent_form_model_refresh() }] : []),
    ];
  }, [choices, query, pinned, refresh]);
  return (
    <ComboBox
      label={label}
      size={controlSize}
      shortcut={false}
      icon={<ListToggle searching={query !== null} />}
      placeholder={m.agent_form_model_search()}
      className={className}
      popoverClassName={popoverClassName}
      isDisabled={isDisabled}
      items={shown}
      defaultFilter={showEverything}
      inputValue={query ?? selectedLabel}
      onInputChange={(value) => setQuery(value === selectedLabel ? null : value)}
      selectedKey={selectedKey}
      onSelectionChange={(key: Key | null) => {
        setQuery(null);
        if (key === EMPTY_KEY) return;
        if (key === REFRESH_KEY) {
          refresh?.run();
          return;
        }
        if (key !== null && String(key) !== selectedKey) onSelectionChange(String(key));
      }}
      onFocus={(event) => {
        if (event.target instanceof HTMLInputElement) event.target.select();
      }}
    >
      {(item) =>
        item.id === EMPTY_KEY ? (
          <SelectItem
            id={item.id}
            label={item.label}
            isDisabled
            selectionIndicator="none"
            className="text-tertiary"
          />
        ) : item.id === REFRESH_KEY ? (
          <SelectItem
            id={item.id}
            label={item.label}
            icon={refresh?.refreshing ? Spinner : RefreshCw01}
            isDisabled={refresh?.busy}
            selectionIndicator="none"
            className="mt-1 border-t border-secondary pt-1 text-tertiary"
          />
        ) : (
          <SelectItem
            id={item.id}
            label={item.label}
            className="[&_[slot=label]]:whitespace-normal [&_[slot=label]]:wrap-break-word"
          />
        )
      }
    </ComboBox>
  );
}

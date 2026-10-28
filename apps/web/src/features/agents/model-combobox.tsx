import { useMemo, useState, type Key } from "react";

import { ComboBox } from "#src/components/base/select/combobox";
import { SelectItem } from "#src/components/base/select/select-item";
import { m } from "#src/paraglide/messages";
import { searchModelChoices, type ModelChoice } from "./model-search";

const showEverything = () => true;

/**
 * The model field: the runtime's models in its own order, filtered as the viewer types (a runtime
 * such as Devin reports over a hundred). Typing searches the name, id and description; the entries
 * in `pinned` stay in every result. Until the viewer types, the input shows the chosen model and
 * opening it lists them all.
 */
export function ModelComboBox({
  label,
  choices,
  pinned,
  selectedKey,
  onSelectionChange,
  isDisabled,
  className,
  popoverClassName,
}: {
  label: string;
  choices: readonly ModelChoice[];
  pinned: ReadonlySet<string>;
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  isDisabled?: boolean;
  className?: string;
  popoverClassName?: string;
}) {
  const selectedLabel = choices.find((choice) => choice.id === selectedKey)?.label ?? "";
  // What the viewer has typed; null while the input shows the chosen model.
  const [query, setQuery] = useState<string | null>(null);
  const shown = useMemo(
    () => searchModelChoices(choices, query ?? "", pinned).map(({ id, label }) => ({ id, label })),
    [choices, query, pinned],
  );
  return (
    <ComboBox
      label={label}
      size="md"
      shortcut={false}
      placeholder={m.agent_form_model_search()}
      className={className}
      popoverClassName={popoverClassName}
      isDisabled={isDisabled}
      items={shown}
      // `searchModelChoices` has already filtered `shown`; the combobox's own filter would match
      // labels only and hide the pinned entries.
      defaultFilter={showEverything}
      inputValue={query ?? selectedLabel}
      onInputChange={(value) => setQuery(value === selectedLabel ? null : value)}
      selectedKey={selectedKey}
      // The combobox commits its selection again on blur and on re-choosing the chosen model;
      // only a different model is a change (it resets the reasoning level, among others).
      onSelectionChange={(key: Key | null) => {
        setQuery(null);
        if (key !== null && String(key) !== selectedKey) onSelectionChange(String(key));
      }}
      // Typing replaces the chosen model's name rather than appending to it.
      onFocus={(event) => {
        if (event.target instanceof HTMLInputElement) event.target.select();
      }}
    >
      {(item) => (
        <SelectItem
          id={item.id}
          label={item.label}
          className="[&_[slot=label]]:whitespace-normal [&_[slot=label]]:wrap-break-word"
        />
      )}
    </ComboBox>
  );
}

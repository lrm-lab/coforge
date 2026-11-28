import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { Input } from "#src/components/base/input/input";
import type { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { fieldHint } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { ModelComboBox, type ModelListRefresh } from "./model-combobox";
import type { ModelChoice } from "./model-search";
import type { RuntimeRefreshNote } from "./runtime-refresh-note";
import { RuntimeRefreshOutcome } from "./runtime-refresh-outcome";

export function AgentRuntimeModelField({
  failed,
  isCodexCompatible,
  controlSize,
  modelRequired,
  modelError,
  initialModel,
  modelValue,
  optionsLoaded,
  refresh,
  modelChoices,
  pinnedModelChoices,
  selectedKey,
  catalogRefreshNote,
  provider,
  onManualChange,
  onSelectionChange,
}: {
  failed: boolean;
  isCodexCompatible: boolean;
  controlSize: ReturnType<typeof useDialogControlSize>;
  modelRequired: boolean;
  modelError?: string;
  initialModel?: string;
  modelValue: string;
  optionsLoaded: boolean;
  refresh: ModelListRefresh;
  modelChoices: readonly ModelChoice[];
  pinnedModelChoices: ReadonlySet<string>;
  selectedKey: string;
  catalogRefreshNote?: RuntimeRefreshNote;
  provider: RuntimeProvider;
  onManualChange: () => void;
  onSelectionChange: (value: string) => void;
}) {
  if (failed) {
    return (
      <Input
        label={m.agent_form_model()}
        name="model"
        size={controlSize}
        isRequired
        validationBehavior={modelRequired ? "aria" : undefined}
        isInvalid={Boolean(modelError)}
        hint={fieldHint(modelError)}
        maxLength={200}
        defaultValue={initialModel}
        className="min-w-0"
        onChange={onManualChange}
      />
    );
  }
  if (isCodexCompatible) return null;
  return (
    <>
      <input type="hidden" name="model" value={modelValue} />
      <div data-field="model" className="relative min-w-0">
        <ModelComboBox
          label={m.agent_form_model()}
          className="min-w-0"
          popoverClassName="min-w-(--trigger-width) w-max max-w-[min(36rem,calc(100vw-3rem))]"
          isDisabled={!optionsLoaded}
          isRequired={modelRequired}
          isInvalid={Boolean(modelError)}
          hint={modelError}
          refresh={refresh}
          choices={modelChoices}
          pinned={pinnedModelChoices}
          selectedKey={selectedKey}
          onSelectionChange={onSelectionChange}
        />
      </div>
      {catalogRefreshNote && <RuntimeRefreshOutcome note={catalogRefreshNote} runtime={provider} />}
    </>
  );
}

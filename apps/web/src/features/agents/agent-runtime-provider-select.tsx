import { type RuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { Select } from "#src/components/base/select/select";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { runtimeUnavailableReason } from "#src/features/computers/runtime-unavailable-reason";
import { m } from "#src/paraglide/messages";
import type { RuntimeOptions } from "./agent-runtime-fields-state";
import {
  compareRuntimeProvidersByLabel,
  RUNTIME_PROVIDER_DISPLAY_ORDER,
  runtimeProviderLabel,
  sortedRuntimeProviders,
} from "./runtime-provider-display";
import { RuntimeProviderMark } from "./runtime-provider-mark";

export function AgentRuntimeProviderSelect({
  provider,
  providers,
  unusable = [],
  error,
  className,
  onChange,
}: {
  provider: RuntimeProvider;
  providers: ReadonlySet<string | undefined>;
  unusable?: RuntimeOptions["unusable"];
  error?: string;
  className?: string;
  onChange: (key: string | number) => void;
}) {
  const controlSize = useDialogControlSize();
  const selectableProviders = sortedRuntimeProviders([
    RUNTIME_PROVIDER.COFORGE,
    ...RUNTIME_PROVIDER_DISPLAY_ORDER.filter((candidate) => providers.has(candidate)),
  ]);
  const selectableProviderSet = new Set(selectableProviders);
  const unavailableEntries = unusable
    .filter((entry) => !selectableProviderSet.has(entry.provider))
    .sort((a, b) => compareRuntimeProvidersByLabel(a.provider, b.provider));

  return (
    <div data-field="provider" className={className}>
      <Select
        label={m.agent_form_provider()}
        size={controlSize}
        className="min-w-0"
        isInvalid={Boolean(error)}
        hint={error}
        selectedKey={provider}
        onSelectionChange={(key) => {
          if (key !== null) onChange(key);
        }}
      >
        {selectableProviders.map((candidate) => (
          <Select.Item
            key={candidate}
            id={candidate}
            label={runtimeProviderLabel(candidate)}
            icon={<RuntimeProviderMark provider={candidate} />}
          />
        ))}
        {unavailableEntries.map((entry) => (
          <Select.Item
            key={entry.provider}
            id={entry.provider}
            label={runtimeProviderLabel(entry.provider)}
            supportingText={runtimeUnavailableReason(entry.unavailableCode, entry.diagnostic)}
            icon={<RuntimeProviderMark provider={entry.provider} />}
            isDisabled
          />
        ))}
      </Select>
    </div>
  );
}

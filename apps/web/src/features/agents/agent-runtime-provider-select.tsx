import { type RuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { Select } from "#src/components/base/select/select";
import { runtimeUnavailableReason } from "#src/features/computers/runtime-unavailable-reason";
import { m } from "#src/paraglide/messages";
import type { RuntimeOptions } from "./agent-runtime-fields-state";
import { RUNTIME_PROVIDER_DISPLAY_ORDER, runtimeProviderLabel } from "./runtime-provider-display";
import { RuntimeProviderMark } from "./runtime-provider-mark";

/** The runtime picker of the Agent forms: CoForge, then the runtimes the Computer can run, then
 * the ones it has but cannot use, each with why. */
export function AgentRuntimeProviderSelect({
  provider,
  providers,
  unusable = [],
  className,
  onChange,
}: {
  provider: RuntimeProvider;
  providers: ReadonlySet<string | undefined>;
  unusable?: RuntimeOptions["unusable"];
  className?: string;
  onChange: (key: string | number) => void;
}) {
  return (
    <Select
      label={m.agent_form_provider()}
      size="sm"
      className={className}
      selectedKey={provider}
      onSelectionChange={(key) => {
        if (key !== null) onChange(key);
      }}
    >
      <Select.Item
        id={RUNTIME_PROVIDER.COFORGE}
        label={runtimeProviderLabel(RUNTIME_PROVIDER.COFORGE)}
        icon={<RuntimeProviderMark provider={RUNTIME_PROVIDER.COFORGE} />}
      />
      {RUNTIME_PROVIDER_DISPLAY_ORDER.filter((candidate) => providers.has(candidate)).map(
        (candidate) => (
          <Select.Item
            key={candidate}
            id={candidate}
            label={runtimeProviderLabel(candidate)}
            icon={<RuntimeProviderMark provider={candidate} />}
          />
        ),
      )}
      {unusable
        .filter((entry) => !providers.has(entry.provider))
        .map((entry) => (
          // Shown, never selectable: the person learns why the runtime they know about is
          // missing from the list instead of finding it gone.
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
  );
}

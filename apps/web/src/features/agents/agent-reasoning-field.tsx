import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";

/** The Reasoning choice of an Agent's runtime: the provider's default, or one of the levels the
 * selected model reports. */
export function AgentReasoningField({
  efforts,
  value,
  onChange,
}: {
  efforts: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      label={m.agent_form_reasoning()}
      size="md"
      className="min-w-0"
      selectedKey={value}
      onSelectionChange={(key) => key !== null && onChange(String(key))}
    >
      <Select.Item id="" label={m.agent_form_provider_default()} />
      {efforts.map((effort) => (
        <Select.Item key={effort} id={effort} label={effort} />
      ))}
    </Select>
  );
}

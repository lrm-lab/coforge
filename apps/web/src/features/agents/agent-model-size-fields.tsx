import { Input } from "#src/components/base/input/input";
import { m } from "#src/paraglide/messages";
import type { CodeAgentModelMetadata } from "@lrm/coforge-sdk/internal";
import { modelSizeInvalid, type ModelSizes } from "./agent-model-sizes";

const TOKENS = new Intl.NumberFormat("en-US");

type ModelSizeField = {
  name: keyof ModelSizes;
  label: () => string;
  help: () => string;
  reported: number | undefined;
  reportedHelp: (params: { tokens: string }) => string;
};

/**
 * The Agent form's model size fields (task #30). Empty is a real answer, not a missing one: the
 * model's own entry then decides, and the hint says which size that is. A person who fills one in
 * wins over the model list, which is why the help text says "leave empty" rather than pre-filling.
 */
export function AgentModelSizeFields({
  value,
  model,
  size,
  onChange,
}: {
  value: ModelSizes;
  /** The selected model, when the catalog knows it: its reported sizes are the fallback hints. */
  model?: CodeAgentModelMetadata;
  size: "sm" | "md" | "lg";
  onChange: (sizes: ModelSizes) => void;
}) {
  const fields: ModelSizeField[] = [
    {
      name: "contextWindow",
      label: m.agent_form_context_window,
      help: m.agent_form_context_window_help,
      reported: model?.contextWindow,
      reportedHelp: m.agent_form_context_window_model,
    },
    {
      name: "maxOutputTokens",
      label: m.agent_form_max_output,
      help: m.agent_form_max_output_help,
      reported: model?.maxOutputTokens,
      reportedHelp: m.agent_form_max_output_model,
    },
  ];
  return (
    <>
      {fields.map((field) => {
        const invalid = modelSizeInvalid(value[field.name]);
        const reported = field.reported === undefined ? undefined : TOKENS.format(field.reported);
        return (
          <Input
            key={field.name}
            label={field.label()}
            name={field.name}
            size={size}
            className="min-w-0"
            value={value[field.name]}
            onChange={(next) => onChange({ ...value, [field.name]: next })}
            isInvalid={invalid}
            hint={
              invalid
                ? m.agent_form_model_size_error()
                : field.reported === undefined
                  ? field.help()
                  : `${field.help()} ${field.reportedHelp({ tokens: reported ?? "" })}`
            }
            placeholder={reported}
          />
        );
      })}
    </>
  );
}

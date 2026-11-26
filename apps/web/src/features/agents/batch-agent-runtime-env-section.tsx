import { ChevronDown, Trash01, XClose } from "@untitledui/icons";
import { Disclosure, DisclosurePanel } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import type { ParsedBatchEnvPatch } from "./batch-runtime-config-model";

const MAX_ENV_ROWS = 64;

export type BatchEnvRow = { key: string; value: string };

export function BatchAgentRuntimeEnvSection({
  isExpanded,
  onExpandedChange,
  envRows,
  onEnvRowsChange,
  envKeyErrors,
  envRemoves,
  onEnvRemovesChange,
  removeInput,
  onRemoveInputChange,
  removeInputError,
  onCommitRemoveKey,
  commonEnvKeys,
  parsedEnv,
}: {
  isExpanded: boolean;
  onExpandedChange: (open: boolean) => void;
  envRows: readonly BatchEnvRow[];
  onEnvRowsChange: (rows: BatchEnvRow[]) => void;
  envKeyErrors: readonly (string | undefined)[];
  envRemoves: readonly string[];
  onEnvRemovesChange: (keys: string[]) => void;
  removeInput: string;
  onRemoveInputChange: (value: string) => void;
  removeInputError: string | undefined;
  onCommitRemoveKey: () => void;
  commonEnvKeys: readonly { key: string; count: number }[];
  parsedEnv: ParsedBatchEnvPatch;
}) {
  const controlSize = useDialogControlSize();
  return (
    <Disclosure isExpanded={isExpanded} onExpandedChange={onExpandedChange}>
      <div className="flex items-center gap-2">
        <Button
          slot="trigger"
          type="button"
          color="tertiary"
          size="sm"
          className="w-max gap-1 px-0 text-xs font-medium text-tertiary"
          iconLeading={ChevronDown}
        >
          {m.agent_batch_env_disclosure()}
        </Button>
        {parsedEnv.hasAny && (
          <Badge size="sm" color="success">
            +{Object.keys(parsedEnv.set).length} / -{parsedEnv.remove.length}
          </Badge>
        )}
      </div>
      <DisclosurePanel>
        <div className="grid gap-3 pt-3">
          <div className="grid gap-1">
            <p className="text-xs font-medium text-tertiary">{m.agent_batch_env_title()}</p>
            <p className="text-sm text-tertiary">{m.agent_batch_env_description()}</p>
          </div>
          {envRows.map((row, index) => (
            <div key={index} className="flex min-w-0 items-start gap-2">
              <Input
                name="batchEnvKey"
                size={controlSize}
                className="min-w-0 flex-1"
                placeholder={m.agent_env_key_placeholder()}
                isInvalid={Boolean(envKeyErrors[index])}
                hint={envKeyErrors[index]}
                value={row.key}
                onChange={(value) =>
                  onEnvRowsChange(envRows.map((r, i) => (i === index ? { ...r, key: value } : r)))
                }
              />
              <span aria-hidden="true" className="flex h-9 items-center text-tertiary">
                =
              </span>
              <Input
                name="batchEnvValue"
                size={controlSize}
                className="min-w-0 flex-1"
                placeholder={m.agent_env_value_placeholder()}
                value={row.value}
                onChange={(value) =>
                  onEnvRowsChange(envRows.map((r, i) => (i === index ? { ...r, value } : r)))
                }
              />
              <div className="flex h-9 items-center">
                <ButtonUtility
                  type="button"
                  size="xs"
                  color="tertiary"
                  icon={Trash01}
                  aria-label={m.agent_env_remove_label({ index: index + 1 })}
                  onClick={() => onEnvRowsChange(envRows.filter((_, i) => i !== index))}
                />
              </div>
            </div>
          ))}
          <Button
            type="button"
            color="secondary"
            size="sm"
            className="justify-self-start"
            isDisabled={envRows.length >= MAX_ENV_ROWS}
            onPress={() => onEnvRowsChange([...envRows, { key: "", value: "" }])}
          >
            {m.agent_env_add()}
          </Button>
          <div className="grid gap-2 border-t border-secondary pt-3">
            <p className="text-xs font-medium text-tertiary">{m.agent_batch_env_remove_title()}</p>
            {envRemoves.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {envRemoves.map((key) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 rounded-md border border-error_subtle bg-error-primary px-2 py-0.5 font-mono text-xs text-error-primary"
                  >
                    <span>-{key}</span>
                    <ButtonUtility
                      type="button"
                      size="xs"
                      color="tertiary"
                      icon={XClose}
                      aria-label={key}
                      onClick={() => onEnvRemovesChange(envRemoves.filter((item) => item !== key))}
                    />
                  </span>
                ))}
              </div>
            )}
            <div className="flex min-w-0 items-start gap-2">
              <Input
                size={controlSize}
                className="min-w-0 flex-1"
                placeholder={m.agent_batch_env_remove_placeholder()}
                isInvalid={Boolean(removeInputError)}
                hint={removeInputError}
                value={removeInput}
                onChange={onRemoveInputChange}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onCommitRemoveKey();
                  }
                }}
              />
              <Button
                type="button"
                color="secondary"
                size="sm"
                isDisabled={!removeInput.trim() || Boolean(removeInputError)}
                onPress={onCommitRemoveKey}
              >
                {m.agent_batch_env_remove_add()}
              </Button>
            </div>
            {commonEnvKeys.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-tertiary">{m.agent_batch_env_existing_label()}</span>
                {commonEnvKeys.slice(0, 8).map(({ key, count }) => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    color="secondary"
                    className="h-auto px-2 py-0.5 font-mono text-xs"
                    onPress={() => onEnvRemovesChange([...envRemoves, key])}
                  >
                    {key} ({count})
                  </Button>
                ))}
              </div>
            )}
          </div>
          {parsedEnv.conflictKeys.length > 0 && (
            <p role="alert" className="text-sm text-error-primary">
              {m.agent_batch_env_conflict_error({
                keys: parsedEnv.conflictKeys.join(", "),
              })}
            </p>
          )}
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

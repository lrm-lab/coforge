import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { useState } from "react";
import { ArrowLeft } from "@untitledui/icons";
import type { WorkbenchRuntime } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { PageHeader } from "#src/components/layout/page-header";
import { m } from "#src/paraglide/messages";

export type WorkbenchComputer = {
  id: string;
  name: string;
  pi?: boolean;
  codex?: boolean;
  codexOnline?: boolean;
  controls?: boolean;
  files?: boolean;
};

export function WorkbenchStart({
  computers,
  computer,
  onComputer,
  onStart,
  onBack,
}: {
  computers: WorkbenchComputer[];
  computer: WorkbenchComputer;
  onComputer(id: string): void;
  onStart(runtime: WorkbenchRuntime): void;
  onBack(): void;
}) {
  const [runtime, setRuntime] = useState<WorkbenchRuntime>(
    computer.codexOnline ? RUNTIME_PROVIDER.CODEX : RUNTIME_PROVIDER.PI,
  );
  const choices = [
    ...(computer.pi !== false ? [{ id: RUNTIME_PROVIDER.PI, label: "Pi" }] : []),
    ...(computer.codex ? [{ id: RUNTIME_PROVIDER.CODEX, label: "Codex" }] : []),
  ];
  const selected = choices.some(({ id }) => id === runtime) ? runtime : choices[0]?.id;
  const canStart =
    selected === RUNTIME_PROVIDER.PI ||
    (selected === RUNTIME_PROVIDER.CODEX && computer.codexOnline);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        heading={m.pi_chat_new()}
        leading={
          <Button
            size="sm"
            color="tertiary"
            iconLeading={ArrowLeft}
            aria-label={m.pi_chat_back()}
            className="lg:hidden"
            onClick={onBack}
          />
        }
      />
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-page py-6 lg:items-center">
        <div className="w-full max-w-sm space-y-4">
          <h2 className="text-lg font-semibold text-primary">{m.pi_chat_native_new()}</h2>
          <Select
            label={m.pi_chat_computer()}
            selectedKey={computer.id}
            onSelectionChange={(id) => id && onComputer(String(id))}
            items={computers.map(({ id, name }) => ({ id, label: name }))}
          >
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
          </Select>
          <Select
            label={m.pi_chat_runtime()}
            selectedKey={selected}
            onSelectionChange={(id) => {
              if (id === RUNTIME_PROVIDER.CODEX || id === RUNTIME_PROVIDER.PI) setRuntime(id);
            }}
            items={choices}
          >
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
          </Select>
          <div>
            <p className="text-sm font-medium text-secondary">{m.pi_chat_working_directory()}</p>
            <p className="mt-1 text-sm text-tertiary">{m.pi_chat_workbench_directory()}</p>
          </div>
          {!canStart && (
            <p role="status" className="text-sm text-tertiary">
              {m.pi_chat_runtime_offline()}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              color="primary"
              isDisabled={!canStart}
              onClick={() =>
                onStart(
                  selected === RUNTIME_PROVIDER.CODEX
                    ? RUNTIME_PROVIDER.CODEX
                    : RUNTIME_PROVIDER.PI,
                )
              }
              className="w-full lg:w-auto"
            >
              {m.pi_chat_start_conversation()}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

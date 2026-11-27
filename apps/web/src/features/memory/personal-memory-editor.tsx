import { useRef, useState } from "react";
import type { LocalMemoryEntry, TeamMemoryDraft } from "@lrm/coforge-sdk/agent";
import { Button } from "#src/components/base/buttons/button";
import { useAppForm } from "#src/components/ui/form";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import * as m from "#src/paraglide/messages";
import { MemoryFields } from "./memory-fields";
import { personalMemoryCommand } from "./personal-memory.functions";
import { personalResponseError } from "./personal-memory-response";

const PERSONAL_MEMORY_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function keyProblem(value: string, required: boolean): string | undefined {
  if (!value) return required ? m.memory_invalid() : undefined;
  return PERSONAL_MEMORY_KEY_PATTERN.test(value) ? undefined : m.memory_invalid();
}

export type PersonalMemoryDraft = TeamMemoryDraft & {
  key: string;
  revision: string;
  restoring: boolean;
};
export const personalMemoryDraft = (entry?: LocalMemoryEntry): PersonalMemoryDraft => ({
  key: entry?.key ?? "",
  revision: entry?.revision ?? "new",
  restoring: entry?.status === "archived",
  title: entry?.title ?? "",
  content: entry?.content ?? "",
  source: entry?.source ?? "",
  kind: entry?.kind ?? "fact",
  applicability: entry?.applicability ?? "",
});
export function PersonalMemoryEditor({
  agentId,
  entry,
  draft,
  onChange,
  onSaved,
  onCancel,
  current,
}: {
  agentId: string;
  entry?: LocalMemoryEntry;
  draft: PersonalMemoryDraft;
  onChange: (patch: Partial<PersonalMemoryDraft>) => void;
  onSaved: (entry?: LocalMemoryEntry) => Promise<void>;
  onCancel: () => void;
  current: () => boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<LocalMemoryEntry>();
  const form = useAppForm({
    defaultValues: {
      key: draft.key,
      title: draft.title,
      content: draft.content,
      source: draft.source,
      kind: draft.kind,
      applicability: draft.applicability,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async () => {
      setBusy(true);
      setError("");
      try {
        const { key, revision, title, content, source, kind, applicability } = draft;
        const result = await personalMemoryCommand({
          data: {
            agentId,
            command: {
              operation: "save",
              key,
              revision,
              title,
              content,
              source,
              kind,
              applicability,
            },
          },
        });
        if (!current()) return;
        const failure = personalResponseError(result);
        if (failure) setError(failure);
        else if (result.status === "ready" && result.result.status === "ok")
          await onSaved(result.result.result.entries[0]);
      } catch {
        if (current()) setError(m.memory_failed());
      } finally {
        setBusy(false);
      }
    },
  });
  const syncChange = (patch: Partial<TeamMemoryDraft>) => {
    if (patch.title !== undefined) form.setFieldValue("title", patch.title);
    if (patch.content !== undefined) form.setFieldValue("content", patch.content);
    if (patch.source !== undefined) form.setFieldValue("source", patch.source);
    if (patch.kind !== undefined) form.setFieldValue("kind", patch.kind);
    if (patch.applicability !== undefined) form.setFieldValue("applicability", patch.applicability);
    onChange(patch);
  };
  return (
    <form.AppForm>
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.AppField
          name="key"
          validators={{
            onChange: ({ value }) => (entry ? undefined : keyProblem(value, false)),
            onSubmit: ({ value }) => (entry ? undefined : keyProblem(value, true)),
          }}
        >
          {(field) => (
            <field.Input
              label={m.memory_key()}
              onChange={(key) => {
                onChange({ key });
                setError("");
              }}
              maxLength={80}
              isDisabled={busy || !!entry}
              isRequired
            />
          )}
        </form.AppField>
        <MemoryFields draft={draft} busy={busy} onChange={syncChange} />
        <form.Alert error={error} />
        {error && entry && (
          <Button
            color="secondary"
            size="sm"
            isDisabled={busy}
            onPress={async () => {
              setBusy(true);
              try {
                const result = await personalMemoryCommand({
                  data: { agentId, command: { operation: "get", key: entry.key } },
                });
                if (!current()) return;
                const failure = personalResponseError(result);
                if (failure) setError(failure);
                else if (result.status === "ready" && result.result.status === "ok")
                  setComparison(result.result.result.entries[0]);
              } catch {
                if (current()) setError(m.memory_failed());
              } finally {
                setBusy(false);
              }
            }}
          >
            {m.memory_reload()}
          </Button>
        )}
        {comparison && (
          <section className="flex flex-col gap-3 border-t border-secondary pt-4">
            <h3 className="text-sm font-semibold text-primary">{m.memory_current()}</h3>
            <p className="whitespace-pre-wrap break-words text-sm text-primary">
              {comparison.content}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm text-secondary">
              {comparison.source}
            </p>
            <Button
              color="secondary"
              onPress={() => {
                onChange({
                  revision: comparison.revision,
                  restoring: draft.restoring || comparison.status === "archived",
                });
                setComparison(undefined);
                setError("");
              }}
            >
              {m.memory_rebase_draft()}
            </Button>
          </section>
        )}
        <div className="flex gap-3">
          <Button
            type="submit"
            isLoading={busy}
            isDisabled={
              !PERSONAL_MEMORY_KEY_PATTERN.test(draft.key) ||
              !draft.title.trim() ||
              !draft.content.trim() ||
              !draft.source.trim()
            }
          >
            {draft.restoring || entry?.status === "archived" ? m.memory_restore() : m.memory_save()}
          </Button>
          <Button color="secondary" isDisabled={busy} onPress={onCancel}>
            {m.memory_cancel()}
          </Button>
        </div>
      </form>
    </form.AppForm>
  );
}

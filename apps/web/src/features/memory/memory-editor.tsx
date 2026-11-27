import { useRef, useState } from "react";
import { type TeamMemoryHead, type TeamMemoryDraft } from "@lrm/coforge-sdk/agent";
import { Button } from "#src/components/base/buttons/button";
import { useAppForm } from "#src/components/ui/form";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import * as m from "#src/paraglide/messages";
import { MemoryFields } from "./memory-fields";
import { MemoryProjectPicker } from "./memory-project-picker";
import { memoryCommand } from "./memory.functions";
import { memoryError, memoryKind } from "./memory-copy";
import { memorySuggestionCommand } from "./memory-suggestions.functions";

export type MemoryDraft = TeamMemoryDraft & { revision: number; reason: string; requestId: string };
export function memoryDraft(entry?: TeamMemoryHead): MemoryDraft {
  return {
    title: entry?.title ?? "",
    content: entry?.content ?? "",
    source: entry?.source ?? "",
    kind: entry?.kind ?? "fact",
    applicability: entry?.applicability ?? "",
    projectId: entry?.projectId ?? null,
    pinned: entry?.pinned ?? false,
    revision: entry?.revision ?? 0,
    reason: "",
    requestId: crypto.randomUUID(),
  };
}
export function MemoryEditor({
  entry,
  draft,
  onChange,
  onSaved,
  onCancel,
  projectName,
  onSuggested,
}: {
  entry?: TeamMemoryHead;
  draft: MemoryDraft;
  onChange: (draft: MemoryDraft) => void;
  onSaved: (entry: TeamMemoryHead) => Promise<void>;
  onCancel: () => void;
  projectName?: string;
  onSuggested?: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const forReviewRef = useRef(false);
  const [projectPending, setProjectPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<TeamMemoryHead>();
  const [comparisonProject, setComparisonProject] = useState<string>();
  const draftValid =
    !projectPending &&
    !!draft.title.trim() &&
    !!draft.content.trim() &&
    !!draft.source.trim() &&
    (!entry || !!draft.reason.trim());
  const send = async (forReview: boolean) => {
    if (!draftValid) return;
    setBusy(true);
    setError("");
    try {
      const { requestId, revision, reason, ...fields } = draft;
      const command = entry
        ? { operation: "update" as const, id: entry.id, requestId, revision, reason, ...fields }
        : { operation: "create" as const, requestId, ...fields };
      if (forReview) {
        const result = await memorySuggestionCommand({
          data: { operation: "submit", draft: command },
        });
        if (result.kind === "error") setError(memoryError(result.error));
        if (result.kind === "queued") onSuggested?.();
        return;
      }
      const result = await memoryCommand({ data: command });
      if (result.kind === "error") setError(memoryError(result.error));
      else if (result.result.entries[0]) await onSaved(result.result.entries[0]);
    } catch {
      setError(m.memory_failed());
    } finally {
      setBusy(false);
    }
  };
  const form = useAppForm({
    defaultValues: {
      title: draft.title,
      content: draft.content,
      source: draft.source,
      kind: draft.kind,
      applicability: draft.applicability,
      projectId: draft.projectId ?? null,
      pinned: draft.pinned ?? false,
      reason: draft.reason,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async () => {
      await send(forReviewRef.current);
    },
  });
  const change = (patch: Partial<MemoryDraft>) => {
    if (patch.title !== undefined) form.setFieldValue("title", patch.title);
    if (patch.content !== undefined) form.setFieldValue("content", patch.content);
    if (patch.source !== undefined) form.setFieldValue("source", patch.source);
    if (patch.kind !== undefined) form.setFieldValue("kind", patch.kind);
    if (patch.applicability !== undefined) form.setFieldValue("applicability", patch.applicability);
    if (patch.projectId !== undefined) form.setFieldValue("projectId", patch.projectId);
    if (patch.pinned !== undefined) form.setFieldValue("pinned", patch.pinned);
    if (patch.reason !== undefined) form.setFieldValue("reason", patch.reason);
    onChange({ ...draft, ...patch, requestId: crypto.randomUUID() });
  };
  return (
    <form.AppForm>
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          forReviewRef.current = false;
          void form.handleSubmit();
        }}
      >
        <MemoryFields draft={draft} busy={busy} onChange={change} />
        <form.AppField name="projectId">
          {(field) => (
            <MemoryProjectPicker
              value={field.state.value}
              selectedName={projectName}
              onChange={(projectId) => {
                field.handleChange(projectId);
                onChange({ ...draft, projectId, requestId: crypto.randomUUID() });
              }}
              onCreatingChange={setProjectPending}
              allowCreate
              disabled={busy}
            />
          )}
        </form.AppField>
        <form.AppField name="pinned">
          {(field) => (
            <field.Checkbox
              label={m.memory_pinned()}
              onChange={(pinned) => onChange({ ...draft, pinned, requestId: crypto.randomUUID() })}
              isDisabled={busy}
            />
          )}
        </form.AppField>
        {entry && (
          <form.AppField
            name="reason"
            validators={{
              onSubmit: ({ value }) => (value.trim() ? undefined : m.memory_invalid()),
            }}
          >
            {(field) => (
              <field.Input
                label={m.memory_reason()}
                onChange={(reason) => {
                  onChange({ ...draft, reason, requestId: crypto.randomUUID() });
                  setError("");
                }}
                isRequired
                maxLength={1000}
                isDisabled={busy}
              />
            )}
          </form.AppField>
        )}
        <form.Alert error={error} />
        {error && entry && (
          <Button
            color="secondary"
            size="sm"
            isDisabled={busy}
            onPress={async () => {
              setBusy(true);
              try {
                const result = await memoryCommand({ data: { operation: "get", id: entry.id } });
                if (result.kind === "error") setError(memoryError(result.error));
                else {
                  const current = result.result.entries[0];
                  setComparison(current);
                  setComparisonProject(
                    current?.projectId ? result.names[current.projectId] : undefined,
                  );
                }
              } catch {
                setError(m.memory_failed());
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
            <h3 className="text-sm font-semibold text-primary">
              {m.memory_current()} · {m.memory_revision({ revision: comparison.revision })}
            </h3>
            <p className="whitespace-pre-wrap break-words text-sm text-primary">
              {comparison.content}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm text-secondary">
              {comparison.source}
            </p>
            <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-3 text-sm">
              <dt className="text-tertiary">{m.memory_applies()}</dt>
              <dd className="break-words text-primary">{comparison.applicability || "—"}</dd>
              <dt className="text-tertiary">{m.memory_kind()}</dt>
              <dd className="text-primary">{memoryKind(comparison.kind)}</dd>
              <dt className="text-tertiary">{m.memory_project()}</dt>
              <dd className="break-words text-primary">
                {comparisonProject ?? m.memory_no_project()}
              </dd>
            </dl>
            <Button
              color="secondary"
              size="sm"
              onPress={() => {
                change({ revision: comparison.revision });
                setComparison(undefined);
                setError("");
              }}
            >
              {m.memory_rebase_draft()}
            </Button>
          </section>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" isLoading={busy} isDisabled={!draftValid}>
            {m.memory_save()}
          </Button>
          {onSuggested && (
            <Button
              color="secondary"
              isDisabled={busy || !draftValid}
              onPress={() => {
                forReviewRef.current = true;
                void form.handleSubmit();
              }}
            >
              {m.memory_review_submit()}
            </Button>
          )}
          <Button color="secondary" isDisabled={busy} onPress={onCancel}>
            {m.memory_cancel()}
          </Button>
        </div>
      </form>
    </form.AppForm>
  );
}

import { useState } from "react";
import { MEMORY_KINDS, type TeamMemoryHead, type TeamMemoryDraft } from "@lrm/coforge-sdk/agent";
import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Select } from "#src/components/base/select/select";
import * as m from "#src/paraglide/messages";
import { MemoryProjectPicker } from "./memory-project-picker";
import { memoryCommand } from "./memory.functions";
import { memoryError, memoryKind } from "./memory-copy";

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
}: {
  entry?: TeamMemoryHead;
  draft: MemoryDraft;
  onChange: (draft: MemoryDraft) => void;
  onSaved: (entry: TeamMemoryHead) => Promise<void>;
  onCancel: () => void;
  projectName?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<TeamMemoryHead>();
  const change = (patch: Partial<MemoryDraft>) =>
    onChange({ ...draft, ...patch, requestId: crypto.randomUUID() });
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          const { requestId, revision, reason, ...fields } = draft;
          const result = await memoryCommand({
            data: entry
              ? { operation: "update", id: entry.id, requestId, revision, reason, ...fields }
              : { operation: "create", requestId, ...fields },
          });
          if (result.kind === "error") setError(memoryError(result.error));
          else if (result.result.entries[0]) await onSaved(result.result.entries[0]);
        } catch {
          setError(m.memory_failed());
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input
        label={m.memory_name()}
        value={draft.title}
        onChange={(title) => change({ title })}
        isRequired
        maxLength={200}
        isDisabled={busy}
      />
      <TextArea
        label={m.memory_content()}
        value={draft.content}
        onChange={(content) => change({ content })}
        isRequired
        maxLength={16000}
        rows={8}
        isDisabled={busy}
      />
      <TextArea
        label={m.memory_source()}
        value={draft.source}
        onChange={(source) => change({ source })}
        isRequired
        maxLength={1000}
        rows={3}
        isDisabled={busy}
      />
      <Input
        label={m.memory_applies()}
        value={draft.applicability}
        onChange={(applicability) => change({ applicability })}
        maxLength={300}
        isDisabled={busy}
      />
      <Select
        label={m.memory_kind()}
        selectedKey={draft.kind}
        onSelectionChange={(key) => {
          const kind = MEMORY_KINDS.find((kind) => kind === key);
          if (kind) change({ kind });
        }}
        isDisabled={busy}
      >
        {MEMORY_KINDS.map((kind) => (
          <Select.Item key={kind} id={kind} label={memoryKind(kind)} />
        ))}
      </Select>
      <MemoryProjectPicker
        value={draft.projectId ?? null}
        selectedName={projectName}
        onChange={(projectId) => change({ projectId })}
        allowCreate
        disabled={busy}
      />
      <Checkbox
        label={m.memory_pinned()}
        isSelected={draft.pinned}
        onChange={(pinned) => change({ pinned })}
        isDisabled={busy}
      />
      {entry && (
        <Input
          label={m.memory_reason()}
          value={draft.reason}
          onChange={(reason) => change({ reason })}
          isRequired
          maxLength={1000}
          isDisabled={busy}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}
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
              else setComparison(result.result.entries[0]);
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
      <div className="flex gap-3">
        <Button
          type="submit"
          isLoading={busy}
          isDisabled={
            !draft.title.trim() ||
            !draft.content.trim() ||
            !draft.source.trim() ||
            (!!entry && !draft.reason.trim())
          }
        >
          {m.memory_save()}
        </Button>
        <Button color="secondary" isDisabled={busy} onPress={onCancel}>
          {m.memory_cancel()}
        </Button>
      </div>
    </form>
  );
}

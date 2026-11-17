import { MEMORY_KINDS, type TeamMemoryDraft } from "@lrm/coforge-sdk/agent";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Select } from "#src/components/base/select/select";
import * as m from "#src/paraglide/messages";
import { memoryKind } from "./memory-copy";

export function MemoryFields({
  draft,
  busy,
  onChange: change,
}: {
  draft: TeamMemoryDraft;
  busy: boolean;
  onChange: (patch: Partial<TeamMemoryDraft>) => void;
}) {
  return (
    <>
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
    </>
  );
}

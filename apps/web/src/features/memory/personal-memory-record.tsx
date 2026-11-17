import type { LocalMemoryEntry } from "@lrm/coforge-sdk/agent";
import * as m from "#src/paraglide/messages";

export function PersonalMemoryRecord({ entry }: { entry: LocalMemoryEntry }) {
  return (
    <>
      <h2 className="break-words text-lg font-semibold text-primary">{entry.title}</h2>
      <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-5 text-sm">
        <dt className="text-tertiary">{m.memory_content()}</dt>
        <dd className="whitespace-pre-wrap break-words text-primary">{entry.content}</dd>
        <dt className="text-tertiary">{m.memory_source()}</dt>
        <dd className="whitespace-pre-wrap break-words text-primary">{entry.source}</dd>
        <dt className="text-tertiary">{m.memory_applies()}</dt>
        <dd className="whitespace-pre-wrap break-words text-primary">
          {entry.applicability || "—"}
        </dd>
      </dl>
    </>
  );
}

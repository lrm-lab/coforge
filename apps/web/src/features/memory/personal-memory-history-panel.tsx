import type { LocalMemoryEntry } from "@lrm/coforge-sdk/agent";
import { Button } from "#src/components/base/buttons/button";
import { EmptyState } from "#src/components/ui/empty";
import * as m from "#src/paraglide/messages";
import { PersonalMemoryVersionTime } from "./personal-memory-record";

export function PersonalMemoryHistoryPanel({
  history,
  historyOffset,
  historical,
  busy,
  onLoadMore,
  onSelectVersion,
  onRestoreVersion,
}: {
  history?: LocalMemoryEntry[];
  historyOffset?: number;
  historical?: LocalMemoryEntry;
  busy: boolean;
  onLoadMore: (offset: number) => void;
  onSelectVersion: (revision: string) => void;
  onRestoreVersion: (entry: LocalMemoryEntry) => void;
}) {
  return (
    <>
      {history && (
        <section className="flex flex-col gap-3 border-t border-secondary pt-4">
          <h3 className="text-sm font-semibold text-primary">{m.memory_history()}</h3>
          {history.length === 0 && (
            <EmptyState size="row" className="px-0" title={m.empty_memory_history_empty()} />
          )}
          {history.map((version) => (
            <div
              key={version.revision}
              className="flex flex-col gap-2 border-b border-secondary py-3"
            >
              <PersonalMemoryVersionTime updatedAt={version.updatedAt} />
              <p className="line-clamp-2 text-sm text-secondary">{version.content}</p>
              <Button
                color="link-gray"
                size="sm"
                isDisabled={busy}
                onPress={() => onSelectVersion(version.revision)}
              >
                {m.memory_full_version()}
              </Button>
            </div>
          ))}
          {historyOffset !== undefined && (
            <Button color="secondary" size="sm" onPress={() => onLoadMore(historyOffset)}>
              {m.memory_next()}
            </Button>
          )}
        </section>
      )}
      {historical && (
        <section className="flex flex-col gap-3 border-t border-secondary pt-4">
          <h3 className="text-sm font-semibold text-primary">{m.memory_historical()}</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-primary">
            {historical.content}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm text-secondary">
            {historical.source}
          </p>
          <Button
            color="secondary"
            size="sm"
            isDisabled={busy}
            onPress={() => onRestoreVersion(historical)}
          >
            {m.memory_restore_version()}
          </Button>
        </section>
      )}
    </>
  );
}

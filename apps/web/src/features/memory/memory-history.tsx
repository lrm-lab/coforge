import { useState } from "react";
import type { TeamMemoryHead } from "@lrm/coforge-sdk/agent";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { MemoryProvenance } from "./memory-provenance";
import * as m from "#src/paraglide/messages";
import { memoryCommand } from "./memory.functions";
import { memoryError } from "./memory-copy";

export function MemoryHistory({
  current,
  onChanged,
}: {
  current: TeamMemoryHead;
  onChanged: () => Promise<void>;
}) {
  const [versions, setVersions] = useState<TeamMemoryHead[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [next, setNext] = useState<number>();
  const [opened, setOpened] = useState(false);
  const [version, setVersion] = useState<TeamMemoryHead>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (offset = 0) => {
    setBusy(true);
    setError("");
    try {
      const result = await memoryCommand({
        data: { operation: "history", id: current.id, offset },
      });
      if (result.kind === "error") setError(memoryError(result.error));
      else {
        setVersions(result.result.entries);
        setNames(result.names);
        setNext(result.result.nextOffset);
        setOpened(true);
      }
    } catch {
      setError(m.memory_failed());
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-4 border-t border-secondary pt-5">
      <Button
        color="secondary"
        size="sm"
        isLoading={busy}
        onPress={() => (opened ? setOpened(false) : load())}
      >
        {m.memory_history()}
      </Button>
      {opened && (
        <ol className="divide-y divide-secondary">
          {versions.map((entry) => (
            <li key={entry.revision} className="flex flex-col gap-2 py-3">
              <p className="text-sm text-secondary">
                {m.memory_revision({ revision: entry.revision })} ·{" "}
                {names[entry.change?.actorUserId ?? entry.change?.actorAgentId ?? ""] ??
                  m.memory_unknown()}
              </p>
              <p className="whitespace-pre-wrap text-sm text-primary">{entry.change?.reason}</p>
              <Button
                color="link-gray"
                size="sm"
                isDisabled={busy}
                onPress={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const result = await memoryCommand({
                      data: { operation: "get", id: current.id, revision: entry.revision },
                    });
                    if (result.kind === "error") setError(memoryError(result.error));
                    else setVersion(result.result.entries[0]);
                  } catch {
                    setError(m.memory_failed());
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {m.memory_full_version()}
              </Button>
            </li>
          ))}
          {next !== undefined && (
            <li className="py-3">
              <Button color="secondary" size="sm" isDisabled={busy} onPress={() => load(next)}>
                {m.memory_next()}
              </Button>
            </li>
          )}
        </ol>
      )}
      {opened && version && (
        <div className="flex flex-col gap-4 border-t border-secondary pt-4">
          <h3 className="text-md font-semibold text-primary">
            {m.memory_revision({ revision: version.revision })}
          </h3>
          <p className="whitespace-pre-wrap text-sm text-primary">{version.content}</p>
          <p className="whitespace-pre-wrap text-sm text-secondary">{version.source}</p>
          <MemoryProvenance entry={version} />
          <Input label={m.memory_reason()} value={reason} onChange={setReason} maxLength={1000} />
          <Button
            color="secondary"
            size="sm"
            isDisabled={busy || !reason.trim()}
            onPress={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await memoryCommand({
                  data: {
                    operation: "restore",
                    id: current.id,
                    revision: current.revision,
                    fromRevision: version.revision,
                    requestId: crypto.randomUUID(),
                    reason,
                  },
                });
                if (result.kind === "error") setError(memoryError(result.error));
                else {
                  await onChanged();
                  setOpened(false);
                  setVersion(undefined);
                }
              } catch {
                setError(m.memory_failed());
              } finally {
                setBusy(false);
              }
            }}
          >
            {m.memory_restore_version()}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}
    </section>
  );
}

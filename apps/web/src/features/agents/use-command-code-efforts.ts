import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { readCommandCodeReasoningEfforts } from "#src/features/computers/command-code-effort.functions";

/**
 * A Command Code model's reasoning efforts, read from the Computer once the form is open with the
 * model selected; `modelId` "" reads nothing. Undefined while the read runs and after it fails.
 * Only a successful read is kept, so a failed one is tried again when the model is selected again
 * or the form reopens.
 */
export function useCommandCodeEfforts({
  open,
  computerId,
  modelId,
}: {
  open: boolean;
  computerId: string;
  modelId: string;
}): string[] | undefined {
  const [effortsByModel, setEffortsByModel] = useState<Record<string, string[]>>({});
  const reading = useRef(new Set<string>());
  const read = useServerFn(readCommandCodeReasoningEfforts);
  const key = `${computerId}\n${modelId}`;

  useEffect(() => {
    if (!open || !computerId || !modelId || effortsByModel[key] || reading.current.has(key)) return;
    reading.current.add(key);
    void read({ data: { computerId, modelId } })
      .then((result) => {
        if (result.status !== "ready") return;
        setEffortsByModel((current) => ({ ...current, [key]: result.efforts }));
      })
      .catch(() => undefined)
      .finally(() => reading.current.delete(key));
  }, [computerId, effortsByModel, key, modelId, open, read]);

  return modelId ? effortsByModel[key] : undefined;
}

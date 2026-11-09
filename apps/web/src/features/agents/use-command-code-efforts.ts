import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  readCommandCodeEffortAnswer,
  startCommandCodeEffortRead,
} from "#src/features/computers/command-code-effort.functions";
import { pollForAnswer } from "#src/features/computers/poll-for-answer";

/** A Computer that has read this model before answers within a moment. */
export const COMMAND_CODE_EFFORT_FIRST_POLL_INTERVAL_MS = 250;
/** How often the form asks for the Computer's answer once it is taking a while. */
export const COMMAND_CODE_EFFORT_POLL_INTERVAL_MS = 1_500;
/** Past the Computer's 30 second CLI read and inside the server's 60 second pending lifetime. */
export const COMMAND_CODE_EFFORT_CLIENT_DEADLINE_MS = 45_000;

/**
 * A Command Code model's reasoning efforts, read from the Computer once the form is open with the
 * model selected; `modelId` "" reads nothing. The read is started and then polled, because
 * production closes a request idle for about ten seconds and the Computer can take thirty. It is
 * undefined while the read runs and after it fails, is refused, passes its deadline, or the form
 * goes away. Only a successful read is kept, so a failed one is tried again when the model is
 * selected again or the form reopens.
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
  // The reads in flight by key, each with the signal it polls under.
  const reading = useRef(new Map<string, AbortSignal>());
  // Made when mounted rather than once, so a remount (Strict Mode's included) does not inherit a
  // stopped controller, and the reads it stopped are not counted as still running.
  const mounted = useRef<AbortController | undefined>(undefined);
  const start = useServerFn(startCommandCodeEffortRead);
  const read = useServerFn(readCommandCodeEffortAnswer);
  const key = `${computerId}\n${modelId}`;

  useEffect(() => {
    const controller = new AbortController();
    const inFlight = reading.current;
    mounted.current = controller;
    return () => {
      controller.abort();
      inFlight.clear();
    };
  }, []);

  useEffect(() => {
    if (!open || !computerId || !modelId || effortsByModel[key] || reading.current.has(key)) return;
    const signal = mounted.current!.signal;
    reading.current.set(key, signal);
    void start({ data: { computerId, modelId } })
      .then(async (started) => {
        if (started.status !== "started") return;
        const answer = await pollForAnswer({
          read: () => read({ data: { computerId, requestId: started.requestId } }),
          onGiveUp: { status: "failed" },
          signal,
          firstIntervalMs: COMMAND_CODE_EFFORT_FIRST_POLL_INTERVAL_MS,
          intervalMs: COMMAND_CODE_EFFORT_POLL_INTERVAL_MS,
          deadlineMs: COMMAND_CODE_EFFORT_CLIENT_DEADLINE_MS,
        });
        if (answer.status !== "ready" || signal.aborted) return;
        setEffortsByModel((current) => ({ ...current, [key]: answer.efforts }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (reading.current.get(key) === signal) reading.current.delete(key);
      });
  }, [computerId, effortsByModel, key, modelId, open, read, start]);

  return modelId ? effortsByModel[key] : undefined;
}

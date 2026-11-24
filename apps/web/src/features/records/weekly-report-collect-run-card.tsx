import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, ChevronDown, ChevronUp } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { loadWeeklyReportCollectRun } from "./records-collect.functions";

function collectRunStatusLabel(status: string): string {
  switch (status) {
    case "collecting":
      return m.records_collect_run_status_collecting();
    case "synthesizing":
      return m.records_collect_run_status_synthesizing();
    case "cancelled":
      return m.records_collect_run_status_cancelled();
    case "done":
      return m.records_collect_run_status_done();
    case "awaiting_confirm":
      return m.records_collect_run_status_awaiting_confirm();
    default:
      return m.records_collect_run_status({ status });
  }
}

function slotTitle(status: string, name: string): string {
  if (status === "ready") return m.records_collect_pack_title({ name });
  if (status === "running") return m.records_collect_slot_running({ name });
  if (status === "empty") return m.records_collect_slot_empty({ name });
  if (status === "stalled") return m.records_collect_slot_stalled({ name });
  return m.records_collect_slot_failed({ name });
}

export function WeeklyReportCollectRunCard(props: {
  runId: string;
  onCollectAdvanced?: (status: string) => void;
}) {
  const load = useServerFn(loadWeeklyReportCollectRun);
  const [run, setRun] = useState<Awaited<ReturnType<typeof loadWeeklyReportCollectRun>> | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const onAdvancedRef = useRef(props.onCollectAdvanced);
  onAdvancedRef.current = props.onCollectAdvanced;
  const leftCollectingNotified = useRef(false);

  const fetchRun = useCallback(async () => {
    const next = await load({ data: { runId: props.runId } });
    setRun(next);
    setLoadFailed(false);
    const notify = onAdvancedRef.current;
    if (next.status === "synthesizing") {
      notify?.(next.status);
    } else if (next.status !== "collecting" && !leftCollectingNotified.current) {
      leftCollectingNotified.current = true;
      notify?.(next.status);
    }
    return next;
  }, [load, props.runId]);

  useEffect(() => {
    leftCollectingNotified.current = false;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function refresh() {
      try {
        const next = await fetchRun();
        if (cancelled) return;
        const inFlight = next.status === "collecting" || next.status === "synthesizing";
        if ((!inFlight || next.allTerminal) && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    }
    void refresh();
    timer = setInterval(() => void refresh(), 4000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [fetchRun]);

  if (!run) {
    if (loadFailed) {
      return (
        <EmptyState
          size="card"
          role="alert"
          picture={<EmptyIcon icon={AlertCircle} size="card" />}
          title={m.empty_records_collect_load_failed()}
          primaryAction={
            <RetryButton
              size="card"
              isRetrying={retrying}
              onPress={() => {
                setRetrying(true);
                void fetchRun()
                  .catch(() => setLoadFailed(true))
                  .finally(() => setRetrying(false));
              }}
            />
          }
        />
      );
    }
    return (
      <div role="status" aria-label={m.records_collect_run_loading()} className="space-y-2">
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    );
  }

  const terminalCount = run.slots.filter((slot) =>
    ["ready", "failed", "empty", "stalled", "cancelled"].includes(slot.status),
  ).length;
  const readyCount = run.slots.filter((slot) => slot.status === "ready").length;
  const runningCount = run.slots.filter((slot) => slot.status === "running").length;
  const statusTone =
    run.status === "collecting" || run.status === "synthesizing"
      ? "border-brand/30 bg-brand-primary text-brand-secondary"
      : run.status === "done" || run.status === "awaiting_confirm"
        ? "border-success/30 bg-success-primary text-success-primary"
        : "border-secondary bg-secondary text-tertiary";

  return (
    <div className="space-y-2">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${statusTone}`}
        role="status"
        aria-live="polite"
      >
        <span className="font-medium">{collectRunStatusLabel(run.status)}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
          <span>
            {m.records_collect_run_computers({
              done: terminalCount,
              total: run.slots.length,
            })}
          </span>
          {readyCount > 0 ? (
            <span>{m.records_collect_run_ready({ count: readyCount })}</span>
          ) : null}
          {runningCount > 0 ? (
            <span>{m.records_collect_run_running({ count: runningCount })}</span>
          ) : null}
        </span>
      </div>
      {run.slots.map((slot) => {
        const open = openIds.includes(slot.id);
        const failedLike =
          slot.status === "failed" || slot.status === "stalled" || slot.status === "cancelled";
        return (
          <div key={slot.id} className="rounded-lg border border-secondary bg-primary">
            <Button
              size="sm"
              color="tertiary"
              className="flex w-full items-center justify-between gap-2 px-3 py-2"
              onPress={() =>
                setOpenIds((prev) =>
                  prev.includes(slot.id) ? prev.filter((id) => id !== slot.id) : [...prev, slot.id],
                )
              }
            >
              <span className="min-w-0 truncate text-start text-sm font-medium text-primary">
                {slotTitle(slot.status, slot.computerLabel)}
              </span>
              {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
            {!open && failedLike && slot.failureReason ? (
              <p className="line-clamp-2 border-t border-secondary px-3 py-1.5 text-xs text-error-primary">
                {slot.failureReason}
              </p>
            ) : null}
            {open ? (
              <div className="border-t border-secondary px-3 py-2">
                {slot.packMarkdown ? (
                  <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap text-secondary">
                    {slot.packMarkdown}
                  </pre>
                ) : (
                  <div className="space-y-1.5">
                    <p className="text-sm text-tertiary">
                      {failedLike
                        ? m.empty_records_collect_load_failed()
                        : m.records_collect_slot_no_body()}
                    </p>
                    {slot.failureReason ? (
                      <details className="text-xs text-tertiary">
                        <summary className="cursor-pointer select-none">
                          {m.empty_details_toggle()}
                        </summary>
                        <p className="mt-1 font-mono break-words">{slot.failureReason}</p>
                      </details>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

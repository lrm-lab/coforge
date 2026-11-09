import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ResetCreditOutcome, RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { consumeResetCredit, readResetCredit, readUsage } from "./computer-usage.functions";
import { awaitResetCredit, usageCarriesAttempt } from "./reset-credit-poll";
import type { ResetCreditStart } from "#src/server/computers/runtime-reset-credit.server";
import { scanRuntimeUsage } from "./usage-scan";
import { runtimeUsageQueryKey } from "./use-runtime-usage";

/** What an attempt came to: what the account settled, or why the Computer was not asked. A
 * refusal leaves the attempt open, as a failed call does; the dialog tells the two apart. */
export type ResetCreditConsumeResult =
  | ResetCreditOutcome
  | Extract<ResetCreditStart, { status: "refused" }>["reason"];

/**
 * The dialog's `onConsume`: starts spending one reset credit, then polls for what the Computer
 * settled, because a request left waiting is closed by production after about ten seconds. A
 * refusal made before the Computer was asked, or while reading, is the result, not a throw; a call
 * that fails does throw, and the dialog keeps the attempt's key either way. No answer by the
 * client's deadline, or the page going away, is `unknown`, so the key is kept and a retry reuses
 * it. The server stores the usage the Computer read afterwards, so a settled answer re-reads the
 * popover's usage; when that read is not the one sent with the answer, the cache still counts the
 * spent credit and stays fresh for half an hour, so the page scans the usage as Refresh does.
 */
export function useConsumeResetCredit() {
  const start = useServerFn(consumeResetCredit);
  const read = useServerFn(readResetCredit);
  const queryClient = useQueryClient();
  // Made when mounted rather than once, so a remount does not inherit a stopped controller.
  const mounted = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => controller.abort();
  }, []);
  return async (
    computerId: string,
    provider: RuntimeProvider,
    idempotencyKey: string,
  ): Promise<ResetCreditConsumeResult> => {
    const started = await start({ data: { computerId, provider, idempotencyKey } });
    if (started.status === "refused") return started.reason;
    const settled = await awaitResetCredit({
      read: () => read({ data: { computerId, provider, requestId: started.requestId } }),
      signal: mounted.current!.signal,
    });
    if (settled.status === "refused") return settled.reason;
    const queryKey = runtimeUsageQueryKey(computerId, provider);
    const usage = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => readUsage({ data: { computerId, provider } }),
      staleTime: 0,
    });
    if (!usageCarriesAttempt(usage, started.requestId))
      // The outcome is settled whether or not this scan answers: a failed one leaves the cache.
      await scanRuntimeUsage(computerId, provider)
        .then((scanned) => queryClient.setQueryData(queryKey, scanned))
        .catch(() => undefined);
    return settled.outcome;
  };
}

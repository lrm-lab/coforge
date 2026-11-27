import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { isAppErrorCode } from "#src/lib/app-error";
import { hour12For, type TimeFormat } from "#src/lib/time-format";
import { m } from "#src/paraglide/messages";
import { ARTIFACTS_KEY, refreshArtifact, type ArtifactDocument } from "./artifact-queries";
import { settleArtifact, unsettleArtifact } from "./artifacts.functions";

export type ArtifactSettledView = ArtifactDocument["artifact"]["settled"];
export type ArtifactReopenedView = ArtifactDocument["artifact"]["reopened"];

export function settlementErrorKind(error: unknown): "forbidden" | "failed" {
  return isAppErrorCode(error, "ACCESS_DENIED") ? "forbidden" : "failed";
}

export function formatSettledTime(
  at: string,
  options: { locale: string; timeZone?: string; timeFormat?: TimeFormat | null },
): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const hour12 = hour12For(options.timeFormat);
  return new Intl.DateTimeFormat(options.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(hour12 !== undefined ? { hour12 } : {}),
  }).format(date);
}

export function useArtifactSettlement({
  artifactId,
  homeId,
  settled,
  reopened,
  canSettle = true,
}: {
  artifactId: string;
  homeId: string | null;
  settled: ArtifactSettledView;
  reopened: ArtifactReopenedView;
  canSettle?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useAppToast();

  const applyOutcome = (next: { settled: ArtifactSettledView; reopened: ArtifactReopenedView }) => {
    queryClient.setQueriesData<ArtifactDocument>(
      { queryKey: [...ARTIFACTS_KEY, "document", artifactId] },
      (current) =>
        current
          ? {
              ...current,
              artifact: {
                ...current.artifact,
                settled: next.settled,
                reopened: next.reopened,
              },
            }
          : current,
    );
    void refreshArtifact(queryClient, artifactId, homeId);
  };

  const settleMutation = useMutation({
    mutationFn: () => settleArtifact({ data: { artifactId } }),
    onSuccess: (outcome) => applyOutcome(outcome.artifact),
    onError: (error) =>
      toast.error(
        settlementErrorKind(error) === "forbidden" ? m.av_settle_forbidden() : m.av_settle_failed(),
      ),
  });

  const unsettleMutation = useMutation({
    mutationFn: () => unsettleArtifact({ data: { artifactId } }),
    onSuccess: (outcome) => applyOutcome(outcome.artifact),
    onError: (error) =>
      toast.error(
        settlementErrorKind(error) === "forbidden" ? m.av_settle_forbidden() : m.av_settle_failed(),
      ),
  });

  const pending = settleMutation.isPending || unsettleMutation.isPending;

  return {
    settled,
    reopened,
    canSettle,
    pending,
    settle: async () => {
      if (!canSettle || pending) return false;
      try {
        await settleMutation.mutateAsync();
        return true;
      } catch {
        return false;
      }
    },
    unsettle: async () => {
      if (!canSettle || pending) return false;
      try {
        await unsettleMutation.mutateAsync();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type ArtifactSettlementState = ReturnType<typeof useArtifactSettlement>;

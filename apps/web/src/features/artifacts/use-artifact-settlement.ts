import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { ARTIFACTS_KEY, refreshArtifact, type ArtifactDocument } from "./artifact-queries";
import { settleArtifact, unsettleArtifact } from "./artifacts.functions";

export type ArtifactSettledView = ArtifactDocument["artifact"]["settled"];
export type ArtifactReopenedView = ArtifactDocument["artifact"]["reopened"];

export function useArtifactSettlement({
  artifactId,
  homeId,
  settled,
  reopened,
}: {
  artifactId: string;
  homeId: string | null;
  settled: ArtifactSettledView;
  reopened: ArtifactReopenedView;
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
    onError: () => toast.error(m.av_settle_failed()),
  });

  const unsettleMutation = useMutation({
    mutationFn: () => unsettleArtifact({ data: { artifactId } }),
    onSuccess: (outcome) => applyOutcome(outcome.artifact),
    onError: () => toast.error(m.av_unsettle_failed()),
  });

  const pending = settleMutation.isPending || unsettleMutation.isPending;

  return {
    settled,
    reopened,
    pending,
    settle: async () => {
      if (pending) return false;
      try {
        await settleMutation.mutateAsync();
        return true;
      } catch {
        return false;
      }
    },
    unsettle: async () => {
      if (pending) return false;
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

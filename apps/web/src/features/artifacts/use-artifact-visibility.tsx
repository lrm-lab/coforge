import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import { useWorkspaceName } from "#src/features/workspaces/workspace-route";
import { lossChanged, narrowRefusalMessage } from "./artifact-narrow-refusal";
import { ARTIFACTS_KEY } from "./artifact-queries";
import { useScopeLabels, visibilityIcon, type VisibilityChoice } from "./artifact-scope";
import type { ArtifactLinkSharing } from "./artifact-link-sharing";
import { loadArtifactAccessLoss, setArtifactAccess } from "./artifacts.functions";

type Confirmation = { choice: VisibilityChoice; narrowing: boolean; linkOff: boolean };

function confirmationFor(
  choice: VisibilityChoice,
  tier: "conversation" | "workspace",
  link: boolean,
): Confirmation | null {
  const narrowing = choice === "conversation" && tier === "workspace";
  const linkOff = choice !== "link" && link;
  if (choice === "link") return link ? null : { choice, narrowing: false, linkOff: false };
  return narrowing || linkOff ? { choice, narrowing, linkOff } : null;
}

export type ArtifactVisibility = ReturnType<typeof useArtifactVisibility>;

export function useArtifactVisibility({
  artifactId,
  tier,
  link,
  homeName,
  canChange,
  narrowable,
}: {
  artifactId: string;
  tier: "conversation" | "workspace";
  link: ArtifactLinkSharing;
  homeName: string | undefined;
  canChange: boolean;
  narrowable: boolean;
}) {
  const queryClient = useQueryClient();
  const workspaceName = useWorkspaceName();
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const current: VisibilityChoice = link.url ? "link" : tier;
  const loss = useQuery({
    queryKey: [...ARTIFACTS_KEY, "access-loss", artifactId],
    queryFn: () => loadArtifactAccessLoss({ data: { artifactId } }),
    enabled: confirming?.narrowing === true,
    gcTime: 0,
    retry: false,
  });
  const refusal = loss.isFetching ? undefined : narrowRefusalMessage(loss.error);
  const lossState: "checking" | "failed" | "refused" | "ready" = loss.isFetching
    ? "checking"
    : refusal !== undefined
      ? "refused"
      : loss.isError
        ? "failed"
        : loss.data
          ? "ready"
          : "checking";

  const apply = async ({ choice, narrowing, linkOff }: Confirmation) => {
    if (linkOff && !narrowing) await link.apply(false);
    if (choice === "link") await link.apply(true);
    else if (choice !== tier)
      await setArtifactAccess({
        data: {
          artifactId,
          access: choice,
          ...(narrowing && loss.data ? { expectedLost: loss.data.total } : {}),
        },
      });
    await queryClient.invalidateQueries({ queryKey: ARTIFACTS_KEY });
  };

  const request = (choice: VisibilityChoice) => {
    if (choice === current) return;
    const needed = confirmationFor(choice, tier, link.url !== null);
    if (needed) setConfirming(needed);
    else void apply({ choice, narrowing: false, linkOff: false }).catch(() => undefined);
  };

  const scopeLabels = useScopeLabels();
  const label = { ...scopeLabels, conversation: homeName ?? scopeLabels.conversation };

  const narrowDescription = {
    checking: m.av_vis_narrow_checking(),
    failed: m.av_vis_narrow_check_failed(),
    refused: refusal ?? "",
    ready: loss.data
      ? m.av_vis_narrow_body({
          people: m.av_vis_narrow_people({ count: loss.data.people }),
          agents: m.av_vis_narrow_agents({ count: loss.data.agents }),
        })
      : "",
  }[lossState];
  const description = confirming
    ? confirming.narrowing
      ? narrowDescription
      : confirming.choice === "link"
        ? m.av_vis_link_on_body()
        : m.av_vis_link_off_body()
    : "";
  const title = confirming
    ? confirming.narrowing
      ? homeName
        ? m.av_vis_narrow_title({ home: homeName })
        : m.av_vis_narrow_title_unnamed()
      : confirming.choice === "link"
        ? m.av_vis_link_on_title()
        : m.av_vis_link_off_title()
    : "";
  const confirmLabel = confirming
    ? confirming.narrowing
      ? m.av_vis_narrow_confirm()
      : confirming.choice === "link"
        ? m.av_vis_link_on_confirm()
        : m.av_vis_link_off_confirm()
    : "";

  const dialog = (
    <ConfirmDialog
      open={confirming !== null}
      onOpenChange={(open) => !open && setConfirming(null)}
      tone="default"
      title={title}
      description={description}
      detail={
        confirming?.narrowing ? (
          <>
            {lossState === "failed" && (
              <Button
                className="mt-2"
                color="secondary"
                size="sm"
                onPress={() => void loss.refetch()}
              >
                {m.controls_retry()}
              </Button>
            )}
            {confirming.linkOff && (
              <span className="mt-2 block">
                {m.av_vis_narrow_link_off({ workspace: workspaceName })}
              </span>
            )}
          </>
        ) : undefined
      }
      confirmDisabled={confirming?.narrowing === true && lossState !== "ready"}
      confirmLabel={confirmLabel}
      errorMessage={(cause) =>
        lossChanged(cause)
          ? m.av_vis_narrow_changed()
          : (narrowRefusalMessage(cause) ?? m.av_vis_failed())
      }
      onConfirm={async () => {
        if (!confirming) return;
        try {
          await apply(confirming);
        } catch (cause) {
          if (lossChanged(cause)) void loss.refetch();
          throw cause;
        }
        setConfirming(null);
      }}
    />
  );

  return {
    current,
    label,
    request,
    dialog,
    confirming: confirming !== null,
    canChange,
    narrowable,
    linkAvailable: link.available,
  };
}

export function VisibilityMenu({ visibility }: { visibility: ArtifactVisibility }) {
  const { current, canChange, narrowable, linkAvailable } = visibility;
  const choices = (["conversation", "workspace", "link"] as const).filter(
    (choice) =>
      choice === current ||
      (canChange &&
        (choice !== "link" || linkAvailable) &&
        (choice !== "conversation" || narrowable)),
  );
  return (
    <Dropdown.Menu
      aria-label={m.av_who_can_see()}
      selectionMode="single"
      selectedKeys={[current]}
      onAction={(key) => visibility.request(key as VisibilityChoice)}
    >
      {choices.map((choice) => (
        <Dropdown.Item
          key={choice}
          id={choice}
          isDisabled={!canChange}
          icon={visibilityIcon[choice]}
          label={visibility.label[choice]}
        />
      ))}
    </Dropdown.Menu>
  );
}

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building02, Globe02, MessageChatCircle } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import { ARTIFACTS_KEY } from "./artifact-queries";
import type { ArtifactLinkSharing } from "./artifact-link-sharing";
import { loadArtifactAccessLoss, setArtifactAccess } from "./artifacts.functions";

export type VisibilityChoice = "conversation" | "workspace" | "link";

export const visibilityIcon = {
  conversation: MessageChatCircle,
  workspace: Building02,
  link: Globe02,
} as const;

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

export function useArtifactVisibility({
  artifactId,
  tier,
  link,
  homeName,
}: {
  artifactId: string;
  tier: "conversation" | "workspace";
  link: ArtifactLinkSharing;
  homeName: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const current: VisibilityChoice = link.url ? "link" : tier;
  const loss = useQuery({
    queryKey: [...ARTIFACTS_KEY, "access-loss", artifactId],
    queryFn: () => loadArtifactAccessLoss({ data: { artifactId } }),
    enabled: confirming?.narrowing === true,
    gcTime: 0,
  });

  const apply = async ({
    choice,
    linkOff,
  }: Confirmation | { choice: VisibilityChoice; linkOff: false }) => {
    if (linkOff) await link.apply(false);
    if (choice === "link") await link.apply(true);
    else if (choice !== tier) await setArtifactAccess({ data: { artifactId, access: choice } });
    await queryClient.invalidateQueries({ queryKey: ARTIFACTS_KEY });
  };

  const request = (choice: VisibilityChoice) => {
    if (choice === current) return;
    const needed = confirmationFor(choice, tier, link.url !== null);
    if (needed) setConfirming(needed);
    else void apply({ choice, linkOff: false }).catch(() => undefined);
  };

  const label = {
    conversation: homeName,
    workspace: m.av_vis_workspace(),
    link: m.av_vis_link(),
  } satisfies Record<VisibilityChoice, string>;

  const description = confirming
    ? confirming.narrowing
      ? loss.data
        ? m.av_vis_narrow_body({ people: loss.data.people, agents: loss.data.agents })
        : ""
      : confirming.choice === "link"
        ? m.av_vis_link_on_body()
        : m.av_vis_link_off_body()
    : "";
  const title = confirming
    ? confirming.narrowing
      ? m.av_vis_narrow_title({ home: homeName })
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
      tone={confirming?.choice === "link" ? "default" : "destructive"}
      title={title}
      description={description}
      detail={
        confirming?.narrowing && confirming.linkOff ? (
          <span className="mt-2 block">{m.av_vis_link_off_body()}</span>
        ) : undefined
      }
      confirmDisabled={confirming?.narrowing === true && !loss.data}
      confirmLabel={confirmLabel}
      errorMessage={m.av_vis_failed()}
      onConfirm={async () => {
        if (confirming) await apply(confirming);
      }}
    />
  );

  return { current, label, request, dialog };
}

export function VisibilityMenu({
  visibility,
  linkAvailable,
}: {
  visibility: Pick<ReturnType<typeof useArtifactVisibility>, "current" | "label" | "request">;
  linkAvailable: boolean;
}) {
  const choices: VisibilityChoice[] = linkAvailable
    ? ["conversation", "workspace", "link"]
    : ["conversation", "workspace"];
  return (
    <Dropdown.Menu
      aria-label={m.av_who_can_see()}
      selectionMode="single"
      selectedKeys={[visibility.current]}
      onAction={(key) => visibility.request(key as VisibilityChoice)}
    >
      {choices.map((choice) => (
        <Dropdown.Item
          key={choice}
          id={choice}
          icon={visibilityIcon[choice]}
          label={visibility.label[choice]}
        />
      ))}
    </Dropdown.Menu>
  );
}

import { Link } from "@tanstack/react-router";
import { MessageTextSquare01 } from "@untitledui/icons";

import { conversationRoute } from "#src/features/conversations/last-conversation";
import { CHIP_CLASS, PRESSABLE_CHIP_CLASS } from "#src/features/conversations/review-chrome";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ArtifactDocument } from "./artifact-queries";

type ArtifactOrigin = NonNullable<ArtifactDocument["artifact"]["origin"]>;

export function originLabel(
  origin: Exclude<ArtifactOrigin, { hidden: true }>,
  name: string | undefined,
): string {
  if (!name) return m.av_origin_hidden();
  return origin.homeKind === "channel"
    ? m.av_origin_channel({ channel: name })
    : m.av_origin_dm({ name: name.replace(/^@/, "") });
}

export function ArtifactOriginLink({
  origin,
  nameOf,
}: {
  origin: ArtifactOrigin | null | undefined;
  nameOf: (conversationId: string) => string | undefined;
}) {
  const workspaceSlug = useWorkspaceSlug();
  if (!origin) return null;
  if ("hidden" in origin) {
    return (
      <span data-artifact-origin="hidden" className={cn(CHIP_CLASS, "shrink-0")}>
        <MessageTextSquare01 aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{m.av_origin_hidden()}</span>
      </span>
    );
  }
  const label = originLabel(origin, nameOf(origin.conversationId));
  return (
    <Link
      {...conversationRoute(
        origin.homeKind === "channel"
          ? { channelId: origin.conversationId }
          : { dmId: origin.conversationId },
        workspaceSlug,
      )}
      search={{ message: origin.messageId }}
      data-artifact-origin={origin.messageId}
      aria-label={label}
      title={label}
      className={cn(PRESSABLE_CHIP_CLASS, "shrink-0")}
    >
      <MessageTextSquare01 aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{m.av_origin_hidden()}</span>
    </Link>
  );
}

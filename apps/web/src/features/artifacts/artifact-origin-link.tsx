import { Link } from "@tanstack/react-router";
import { MessageTextSquare01 } from "@untitledui/icons";

import { messageHash } from "#src/features/conversations/conversation-page-search";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { CHIP_CLASS, PRESSABLE_CHIP_CLASS } from "#src/features/conversations/review-chrome";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ArtifactDocument } from "./artifact-queries";

type ArtifactOrigin = NonNullable<ArtifactDocument["artifact"]["origin"]>;
type VisibleOrigin = Exclude<ArtifactOrigin, { hidden: true }>;

export function originLabel(origin: VisibleOrigin, name: string | undefined): string {
  if (!name) return m.av_origin_hidden();
  return origin.homeKind === "channel"
    ? m.av_origin_channel({ channel: name })
    : m.av_origin_dm({ name: name.replace(/^@/, "") });
}

export function originJump(origin: VisibleOrigin): {
  search: { message: string; threadRootId?: string };
  hash?: string;
} {
  if (!origin.threadRootId) return { search: { message: origin.messageId } };
  return {
    search: { threadRootId: origin.threadRootId, message: origin.threadRootId },
    hash: messageHash(origin.messageId),
  };
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
      {...originJump(origin)}
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

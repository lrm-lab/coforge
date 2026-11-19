import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { useAppToast } from "#src/components/ui/toast";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { buildAiPromptUrl, formatArtifactForAi, type AiProvider } from "./artifact-ai-shortcuts";
import { artifactDownloadUrl } from "./artifact-download-url";
import { embedCode, type ArtifactLinkSharing } from "./artifact-link-sharing";
import type { MoreAction } from "./artifact-more-menu";
import { ArtifactRenameDialog } from "./artifact-rename-dialog";
import { artifactFollowingQuery, refreshArtifact } from "./artifact-queries";
import { setArtifactFollowing, renameArtifact } from "./artifact-viewer.functions";
import { ARTIFACT_ZIP_LIMIT_BYTES } from "./artifact-zip-limit";

export function useArtifactActions({
  artifactId,
  homeId,
  title,
  shownVersion,
  entryPath,
  body,
  files,
  link,
  loaded,
  actions,
}: {
  artifactId: string;
  homeId: string | null;
  title: string;
  shownVersion: number;
  entryPath: string;
  body?: string | null;
  files: readonly { path: string; sizeBytes: number }[];
  link: ArtifactLinkSharing;
  loaded: boolean;
  actions: Record<"find" | "copy-link" | "send" | "comments" | "files" | "delete", () => void>;
}) {
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const workspaceSlug = useWorkspaceSlug();
  const [renaming, setRenaming] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const following = useQuery({ ...artifactFollowingQuery(artifactId), enabled: loaded });
  const follow = useMutation({
    mutationFn: (next: boolean) => setArtifactFollowing({ data: { artifactId, following: next } }),
    onSuccess: (next) =>
      queryClient.setQueryData(artifactFollowingQuery(artifactId).queryKey, next),
    onError: () => toast.error(m.av_follow_failed()),
  });

  const copyEmbed = async (url: string) => {
    if (await copyText(embedCode(url, title))) toast.success(m.av_embed_copied());
    else toast.error(m.conversation_copy_failed());
  };

  const aiContext = () => ({
    title,
    version: shownVersion,
    url: link.url ?? (typeof window === "undefined" ? undefined : window.location.href),
    body,
  });

  const copyForAi = async () => {
    if (await copyText(formatArtifactForAi(aiContext()))) toast.success(m.av_ai_copied());
    else toast.error(m.conversation_copy_failed());
  };

  const openInAi = (provider: AiProvider) => {
    window.open(buildAiPromptUrl(provider, aiContext()), "_blank", "noopener,noreferrer");
  };

  const download = () => {
    const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const single = files.length <= 1;
    if (!single && total > ARTIFACT_ZIP_LIMIT_BYTES) {
      toast.error(m.av_zip_too_large());
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = artifactDownloadUrl(workspaceSlug, artifactId, {
      version: shownVersion,
      ...(single ? { path: files[0]?.path ?? entryPath } : {}),
    });
    anchor.click();
  };

  const onMoreAction = (action: MoreAction) => {
    switch (action) {
      case "embed":
        if (link.url) void copyEmbed(link.url);
        else setEmbedding(true);
        return;
      case "copy-for-ai":
        void copyForAi();
        return;
      case "open-chatgpt":
        openInAi("chatgpt");
        return;
      case "open-claude":
        openInAi("claude");
        return;
      case "rename":
        setRenaming(true);
        return;
      case "download":
        download();
        return;
      case "follow":
        follow.mutate(!following.data);
        return;
      default:
        actions[action]();
    }
  };

  const dialogs: ReactNode = (
    <>
      {renaming && (
        <ArtifactRenameDialog
          title={title}
          onClose={() => setRenaming(false)}
          onRename={async (next) => {
            await renameArtifact({ data: { artifactId, title: next } });
            await refreshArtifact(queryClient, artifactId, homeId);
          }}
        />
      )}
      <ConfirmDialog
        open={embedding}
        onOpenChange={setEmbedding}
        tone="default"
        title={m.av_embed_link_title()}
        description={m.av_embed_link_body()}
        confirmLabel={m.av_embed_link_confirm()}
        errorMessage={m.av_vis_failed()}
        onConfirm={async () => {
          const url = await link.apply(true);
          if (url) await copyEmbed(url);
        }}
      />
    </>
  );

  return { onMoreAction, dialogs, following: following.data === true };
}

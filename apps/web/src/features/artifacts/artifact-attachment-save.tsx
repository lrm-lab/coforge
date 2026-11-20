import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { FilePlus02 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { useArtifactLink } from "./artifact-beside-chat";
import { ARTIFACTS_KEY } from "./artifact-queries";
import { saveAttachmentAsArtifact } from "./artifacts.functions";

const MAX_SAVE_BYTES = 16 * 1024 * 1024;

export function SaveAttachmentAsArtifactButton({
  attachmentId,
  sizeBytes,
}: {
  attachmentId: string;
  sizeBytes: number;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const linkTo = useArtifactLink();
  const toast = useAppToast();

  const save = useMutation({
    mutationFn: () => saveAttachmentAsArtifact({ data: { attachmentId } }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ARTIFACTS_KEY });
      toast.success(result.artifact.title || result.attachment.fileName);
      void router.navigate(linkTo(result.artifact.id));
    },
    onError: () => {
      toast.error(m.doc_unavailable_title());
    },
  });

  if (sizeBytes > MAX_SAVE_BYTES) return null;

  return (
    <ButtonUtility
      icon={FilePlus02}
      size="xs"
      color="tertiary"
      isDisabled={save.isPending}
      tooltip={m.doc_filter_artifacts()}
      aria-label={m.doc_filter_artifacts()}
      className="opacity-0 transition-opacity duration-150 group-hover/att:opacity-100 focus-visible:opacity-100"
      onClick={() => {
        if (!save.isPending) save.mutate();
      }}
    />
  );
}

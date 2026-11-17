import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { artifactLinkSharingQuery } from "./artifact-queries";
import { setArtifactLinkSharing } from "./artifacts.functions";

export type ArtifactLinkSharing = {
  loaded: boolean;
  available: boolean;
  url: string | null;
  current: () => Promise<string | null>;
  apply: (enabled: boolean) => Promise<string | null>;
};

export function useArtifactLinkSharing(artifactId: string, enabled: boolean): ArtifactLinkSharing {
  const queryClient = useQueryClient();
  const query = artifactLinkSharingQuery(artifactId);
  const { data } = useQuery({ ...query, enabled });
  const write = useMutation({
    mutationFn: (next: boolean) => setArtifactLinkSharing({ data: { artifactId, enabled: next } }),
    onSuccess: (result) =>
      queryClient.setQueryData(query.queryKey, (read) =>
        read ? { ...read, url: result.enabled ? result.url : null } : read,
      ),
    onError: () => void queryClient.invalidateQueries({ queryKey: query.queryKey }),
  });
  return {
    loaded: data !== undefined,
    available: data?.available === true,
    url: data?.url ?? null,
    current: async () => (await queryClient.fetchQuery(query)).url,
    apply: async (next) => {
      const result = await write.mutateAsync(next);
      return result.enabled ? result.url : null;
    },
  };
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export const embedCode = (url: string, title: string) =>
  `<iframe src="${escapeAttribute(url)}" title="${escapeAttribute(title)}" width="100%" height="600" style="border:0" loading="lazy"></iframe>`;

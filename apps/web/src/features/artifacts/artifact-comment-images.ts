export const commentImageUrl = (workspaceSlug: string, artifactId: string, imageId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${artifactId}/comment-images/${imageId}`;

export async function uploadCommentImage(
  workspaceSlug: string,
  artifactId: string,
  file: File,
): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${artifactId}/comment-images`,
    { method: "POST", body: form },
  );
  if (!response.ok) throw new Error(`upload refused: ${response.status}`);
  const { sha256 } = (await response.json()) as { sha256: string };
  return sha256;
}

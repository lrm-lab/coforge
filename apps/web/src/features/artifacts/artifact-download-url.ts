export function artifactDownloadUrl(
  workspaceSlug: string,
  artifactId: string,
  options: { path?: string; version?: number } = {},
): string {
  const query = new URLSearchParams();
  if (options.path !== undefined) query.set("path", options.path);
  if (options.version !== undefined) query.set("version", String(options.version));
  const suffix = query.size > 0 ? `?${query}` : "";
  return `/api/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${artifactId}/download${suffix}`;
}

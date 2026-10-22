/** What a cloud image replace drops, and what the named volume keeps. */
export const cloudImageUpdateConsequences = {
  lost: ["in_flight_runs", "volatile_memory", "brief_disconnect"] as const,
  kept: ["volume_files", "workspace_bindings", "agents_after_reconnect"] as const,
};

const IMAGE_LAYER = /(?:^|@)(sha256:[0-9a-f]{64})$/i;

/** The content-addressed layer, whether the value is a raw id or a tagged digest. */
export function imageLayerId(reference: string): string | undefined {
  const match = IMAGE_LAYER.exec(reference.trim());
  return match?.[1]?.toLowerCase();
}

export function sameImageLayer(left: string, right: string): boolean {
  return (imageLayerId(left) ?? left.trim()) === (imageLayerId(right) ?? right.trim());
}

export function cloudImageOfferLabel(image: { id: string; version: string }): string {
  const version = image.version.trim();
  if (version) return version;
  const layer = imageLayerId(image.id);
  if (layer) return layer.slice("sha256:".length, "sha256:".length + 12);
  return image.id.trim();
}

export function cloudImageUpdateAvailable(
  runningImageId: string | undefined,
  availableImageId: string | undefined,
): boolean {
  return Boolean(
    runningImageId && availableImageId && !sameImageLayer(runningImageId, availableImageId),
  );
}

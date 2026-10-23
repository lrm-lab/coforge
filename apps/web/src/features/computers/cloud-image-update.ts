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

export type CloudComputerImage = {
  /** The image this computer is running: the node image's label when the layers match. */
  version: string;
  /** Set when the node image is a different layer. */
  update?: { imageId: string; version: string };
};

/** The image row for one computer in a host snapshot, or none when that computer is not running. */
export function cloudComputerImage(
  snapshot: {
    image: { id: string; version: string };
    computers: Array<{ computerId: string; imageId: string; retained?: boolean }>;
  },
  computerId: string,
): CloudComputerImage | undefined {
  const running = snapshot.computers.find((computer) => computer.computerId === computerId);
  if (!running) return undefined;
  const nodeVersion = cloudImageOfferLabel(snapshot.image);
  if (running.retained)
    return { version: cloudImageOfferLabel({ id: running.imageId, version: "" }) };
  if (sameImageLayer(running.imageId, snapshot.image.id)) return { version: nodeVersion };
  return {
    version: cloudImageOfferLabel({ id: running.imageId, version: "" }),
    update: { imageId: snapshot.image.id, version: nodeVersion },
  };
}

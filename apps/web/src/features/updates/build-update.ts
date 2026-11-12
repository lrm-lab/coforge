export const CLIENT_BUILD_ID =
  typeof __COFORGE_BUILD_ID__ === "string" ? __COFORGE_BUILD_ID__ : "development";

export type BuildUpdateState = {
  updateDetected: boolean;
};

let unsavedTemporaryStateCount = 0;

export function registerUnsavedTemporaryState(active: boolean): () => void {
  if (!active) return () => {};
  unsavedTemporaryStateCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsavedTemporaryStateCount = Math.max(0, unsavedTemporaryStateCount - 1);
  };
}

export function buildUpdateStateAfterProbe(
  state: BuildUpdateState,
  clientBuildId: string,
  serverBuildId: string,
): BuildUpdateState {
  return state.updateDetected || clientBuildId !== serverBuildId ? { updateDetected: true } : state;
}

export function isChunkLoadError(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "ChunkLoadError") return true;
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return (
    /^Loading chunk [^ ]+ failed(?:\.|$)/iu.test(message) ||
    /Failed to fetch dynamically imported module/iu.test(message) ||
    /Importing a module script failed/iu.test(message) ||
    /error loading dynamically imported module/iu.test(message)
  );
}

export function hasUnsavedTemporaryState(): boolean {
  return unsavedTemporaryStateCount > 0;
}

export const CLIENT_BUILD_ID =
  typeof __COFORGE_BUILD_ID__ === "string" ? __COFORGE_BUILD_ID__ : "development";

export type BuildUpdateState = {
  updateDetected: boolean;
};

export type BuildUpdateProbeOutcome = "same" | "updated" | "unavailable" | "skipped";

export type BuildUpdateController = {
  probe: () => Promise<BuildUpdateProbeOutcome>;
  handleChunkLoadError: () => Promise<BuildUpdateProbeOutcome>;
  isUpdateDetected: () => boolean;
};

export function createBuildUpdateController(options: {
  clientBuildId: string;
  fetchBuildId: () => Promise<string | undefined>;
  isOffline?: () => boolean;
  onUpdateDetected: () => void;
}): BuildUpdateController {
  let state: BuildUpdateState = { updateDetected: false };
  let inFlight: Promise<BuildUpdateProbeOutcome> | null = null;
  let noticeShown = false;

  const notifyOnce = () => {
    if (noticeShown) return;
    noticeShown = true;
    options.onUpdateDetected();
  };

  const probe = (): Promise<BuildUpdateProbeOutcome> => {
    if (options.clientBuildId === "development") return Promise.resolve("skipped");
    if (state.updateDetected) {
      notifyOnce();
      return Promise.resolve("updated");
    }
    if (options.isOffline?.()) return Promise.resolve("unavailable");
    if (inFlight) return inFlight;

    inFlight = (async () => {
      let serverBuildId: string | undefined;
      try {
        serverBuildId = await options.fetchBuildId();
      } catch {
        serverBuildId = undefined;
      }
      if (serverBuildId === undefined) return "unavailable";
      state = buildUpdateStateAfterProbe(state, options.clientBuildId, serverBuildId);
      if (state.updateDetected) {
        notifyOnce();
        return "updated";
      }
      return "same";
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  return {
    probe,
    handleChunkLoadError: () => probe(),
    isUpdateDetected: () => state.updateDetected,
  };
}

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

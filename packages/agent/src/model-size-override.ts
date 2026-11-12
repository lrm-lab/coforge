/** What a person filled in on an Agent's form; absent leaves the runtime's own model entry in
 * charge of that number (task #30). */
export type ModelSizeOverride = Readonly<{
  contextWindow?: number;
  maxOutputTokens?: number;
}>;

/**
 * The model a launch runs with, sized by the form where it said so.
 *
 * A copy, never the registry's entry: another launch in this process may keep the runtime's own
 * sizes. Pi names the maximum output `maxTokens`; the form and the wire name it
 * `maxOutputTokens`. The context window matters beyond the request — Pi compacts against it — so
 * the override has to land on the model itself, not on the log that reports the window.
 */
export function modelWithSizes<T extends { contextWindow: number; maxTokens: number }>(
  model: T,
  sizes: ModelSizeOverride,
): T {
  const { contextWindow, maxOutputTokens } = sizes;
  if (contextWindow === undefined && maxOutputTokens === undefined) return model;
  return {
    ...model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxTokens: maxOutputTokens }),
  };
}

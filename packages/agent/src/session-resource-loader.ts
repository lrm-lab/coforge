import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const EVAL_DISABLE_HOST_PI_INJECTION = "COFORGE_EVAL_DISABLE_HOST_PI_INJECTION";
export function evalDisablesHostPiInjection(
  env: {
    [key: string]: string | undefined;
  } = Bun.env,
): boolean {
  const value = env[EVAL_DISABLE_HOST_PI_INJECTION];
  return value === "1" || value === "true";
}
export function resourceLoaderOptionsForSession(input: {
  instructions: string;
  disableHostPiInjection?: boolean;
  extensionFactories?: InlineExtension[];
}) {
  const isolate = Boolean(input.disableHostPiInjection);
  return {
    systemPromptOverride: () => input.instructions,
    ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}),
    ...(isolate ? { noSkills: true, noContextFiles: true, noExtensions: true } : {}),
  };
}

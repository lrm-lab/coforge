export const EVAL_DISABLE_HOST_PI_INJECTION = "COFORGE_EVAL_DISABLE_HOST_PI_INJECTION";

export function evalDisablesHostPiInjection(
  env: { [key: string]: string | undefined } = Bun.env,
): boolean {
  const value = env[EVAL_DISABLE_HOST_PI_INJECTION];
  return value === "1" || value === "true";
}

/** Memory Agent and public-channel eval sessions must not ingest Pi host skills,
 * context files, or extensions. Team memory and skills come from the Memory Agent. */
export function resourceLoaderOptionsForSession(input: {
  instructions: string;
  memoryFence?: boolean;
  disableHostPiInjection?: boolean;
}) {
  const isolate = Boolean(input.memoryFence || input.disableHostPiInjection);
  return {
    systemPromptOverride: () => input.instructions,
    ...(isolate ? { noSkills: true, noContextFiles: true, noExtensions: true } : {}),
  };
}

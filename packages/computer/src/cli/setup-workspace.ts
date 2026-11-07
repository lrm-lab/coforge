/** `--workspace` wins over the automation intent; a blank explicit value stays supplied so the
 * caller can report it as invalid instead of silently falling through. */
export function resolveSetupWorkspace(cliWorkspace: string | undefined): string | undefined {
  return cliWorkspace !== undefined ? cliWorkspace : readSetupIntentWorkspace();
}

function readSetupIntentWorkspace(): string | undefined {
  const raw = process.env.COFORGE_SETUP_INTENT;
  if (!raw) return undefined;
  try {
    const intent: unknown = JSON.parse(raw);
    if (typeof intent === "object" && intent !== null && "workspaceSlug" in intent) {
      const slug = (intent as { workspaceSlug?: unknown }).workspaceSlug;
      return typeof slug === "string" && slug.length > 0 ? slug : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

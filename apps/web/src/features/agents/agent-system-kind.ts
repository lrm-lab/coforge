/** Server-owned execution identity. This is never accepted by Agent create/edit inputs. */
export const WORKSPACE_ASSISTANT_KIND = "workspace-assistant";

/** An app's bot (`server/app-bots/`): a managed Agent with no Computer, made by a Workspace
 * owner's or admin's grant and spoken for by the app's backend. Never accepted by Agent
 * create/edit inputs. */
export const APP_BOT_KIND = "app-bot";

/** Whether an Agent is an app's bot: the one test every surface that treats a bot differently (no
 * Computer, no launch, not in a roster, not in `#general`) goes through. */
export function isAppBot(agent: { systemKind?: string | null } | null | undefined): boolean {
  return agent?.systemKind === APP_BOT_KIND;
}

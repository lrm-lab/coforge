import type { ActionCardAction } from "@lrm/coforge-sdk/agent";
import { bareHandle } from "./action-card-handles.server";
import { appRecoverOwnerSummary } from "./app-recover-owner-action-cards.server";
import { appRegisterSummary } from "./app-register-action-cards.server";

const ensureAt = (value: string) => (value.startsWith("@") ? value : `@${value}`);
const ensureHash = (value: string) => (value.startsWith("#") ? value : `#${value}`);

/** The one-line, human-readable summary that becomes the posted Message body. */
export function actionCardSummary(action: ActionCardAction): string {
  if (action.type === "app:register") return appRegisterSummary(action);
  if (action.type === "app:recover_owner") return appRecoverOwnerSummary(action);
  if (action.type === "channel:create") return `Action card: create channel #${action.name}`;
  if (action.type === "agent:create") return `Action card: create agent ${action.name}`;
  const actors = [...(action.humans ?? []), ...(action.agents ?? [])].map(ensureAt);
  return `Action card: add ${actors.join(", ")} to ${ensureHash(bareHandle(action.channel))}`;
}

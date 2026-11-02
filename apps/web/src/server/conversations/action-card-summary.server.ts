import type { ActionCardAction } from "@lrm/coforge-sdk/agent";
import { choiceLetter } from "#src/features/conversations/choice-letter";
import { bareHandle } from "./action-card-handles.server";
import { appRecoverOwnerSummary } from "./app-recover-owner-action-cards.server";
import { appRegisterSummary } from "./app-register-action-cards.server";

const ensureAt = (value: string) => (value.startsWith("@") ? value : `@${value}`);
const ensureHash = (value: string) => (value.startsWith("#") ? value : `#${value}`);

/** The one-line, human-readable summary that becomes the posted Message body. */
export function actionCardSummary(action: ActionCardAction): string {
  if (action.type === "app:register") return appRegisterSummary(action);
  if (action.type === "app:recover_owner") return appRecoverOwnerSummary(action);
  if (action.type === "page:fill") {
    const labels = action.fields.map((field) => field.label).join(", ");
    return action.prompt
      ? `Fill the page: ${action.prompt} (${labels})`
      : `Fill the page: ${labels}`;
  }
  if (action.type === "desktop:takeover") {
    return action.prompt
      ? `Open the cloud desktop: ${action.prompt}`
      : "Open the cloud desktop to finish this step";
  }
  if (action.type === "choice") {
    // Lettered as the card letters them, so a reply of "B" reads as the second option. No English
    // lead-in: the body is the card's preview, and the question is in the asker's own language.
    const labels = action.options
      .map((option, index) => `${choiceLetter(index)}. ${option.label}`)
      .join("; ");
    return `${action.prompt} (${labels})`;
  }
  if (action.type === "channel:create") return `Action card: create channel #${action.name}`;
  if (action.type === "agent:create") return `Action card: create agent ${action.name}`;
  const actors = [...(action.humans ?? []), ...(action.agents ?? [])].map(ensureAt);
  return `Action card: add ${actors.join(", ")} to ${ensureHash(bareHandle(action.channel))}`;
}

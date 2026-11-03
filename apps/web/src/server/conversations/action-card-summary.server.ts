import type { ActionCardAction, ChannelAddMemberAction } from "@lrm/coforge-sdk/agent";
import { choiceNumber } from "#src/features/conversations/choice-number";
import { bareHandle } from "./action-card-handles.server";
import { appRecoverOwnerSummary } from "./app-recover-owner-action-cards.server";
import { appRegisterSummary } from "./app-register-action-cards.server";

const ensureAt = (value: string) => (value.startsWith("@") ? value : `@${value}`);

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
    // Numbered as the card numbers them, so a reply of "2" reads as the second option. No English
    // lead-in: the body is the card's preview, and the question is in the asker's own language.
    const labels = action.options
      .map((option, index) => `${choiceNumber(index)}. ${option.label}`)
      .join("; ");
    return `${action.prompt} (${labels})`;
  }
  if (action.type === "channel:create") return `Action card: create channel #${action.name}`;
  if (action.type === "agent:create") return `Action card: create agent ${action.name}`;
  const { channelHandle, memberHandles } = addMemberHandles(action);
  return `Action card: add ${memberHandles.join(", ")} to #${channelHandle}`;
}

/** The channel (bare) and members (`@handle`) an `add_member` card names, as the Agent wrote them:
 * its body, and the snapshot its payload keeps for the preview line. */
export function addMemberHandles(action: ChannelAddMemberAction) {
  return {
    channelHandle: bareHandle(action.channel),
    memberHandles: [...(action.humans ?? []), ...(action.agents ?? [])].map(ensureAt),
  };
}

import { m } from "#src/paraglide/messages";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";

/** Title shown in the card header. */
export function actionCardTitle(view: ActionCardView): string {
  switch (view.kind) {
    case "page:fill":
      return m.action_card_title_page_fill();
    case "desktop:takeover":
      return m.action_card_title_desktop_takeover();
    case "channel:create":
      return m.action_card_title_channel_create();
    case "agent:create":
      return m.action_card_title_agent_create();
    case "app:grant_agent":
      return m.app_card_title();
    case "app:register":
      return m.app_register_card_title();
    case "app:recover_owner":
      return m.app_recover_card_title();
    default:
      return m.action_card_title_add_member();
  }
}

/** Primary commit button label while pending, or its progressive form while `working`. */
export function actionCardCommitLabel(view: ActionCardView, working: boolean): string {
  switch (view.kind) {
    case "page:fill":
      return working ? m.action_card_page_fill_filling() : m.action_card_commit_page_fill();
    case "desktop:takeover":
      return working ? m.action_card_finishing() : m.action_card_commit_desktop_takeover();
    case "channel:create":
      return working ? m.action_card_creating() : m.action_card_commit_channel_create();
    case "agent:create":
      return working ? m.action_card_creating() : m.action_card_commit_agent_create();
    case "app:grant_agent":
      return working ? m.app_card_approving() : m.agent_apps_approve();
    case "app:register":
      return working ? m.app_register_card_committing() : m.app_register_card_commit();
    case "app:recover_owner":
      return working ? m.app_recover_card_committing() : m.app_recover_card_commit();
    default:
      return working ? m.action_card_adding() : m.action_card_commit_add_member();
  }
}

/** The cancel button's label, or its progressive form while `working`. An app's request for
 * access is denied, not dismissed. */
export function actionCardCancelLabel(view: ActionCardView, working: boolean): string {
  if (view.kind === "app:grant_agent") return working ? m.app_card_denying() : m.agent_apps_deny();
  return working ? m.action_card_cancelling() : m.action_card_dismiss();
}

/** The kinds with a dialog to change the draft before committing it. */
export function actionCardEditable(view: ActionCardView): boolean {
  return view.kind === "channel:create" || view.kind === "channel:add_member";
}

/** What the handled line says was done, in gray before its result. A card closed without being
 * done names the action itself, so its title stands in for the past tense. */
export function actionCardHandledVerb(view: ActionCardView): string {
  if (view.state === "cancelled") return actionCardTitle(view);
  switch (view.kind) {
    case "page:fill":
      return m.action_card_page_fill_done();
    case "desktop:takeover":
      return m.action_card_desktop_takeover_done();
    case "channel:create":
      return m.action_card_handled_channel_create();
    case "agent:create":
      return m.action_card_handled_agent_create();
    case "app:grant_agent":
      return m.action_card_handled_app_grant();
    case "app:register":
      return m.action_card_handled_app_register();
    case "app:recover_owner":
      return m.action_card_handled_app_recover();
    default:
      return m.action_card_handled_add_member();
  }
}

/** Why this viewer cannot commit, when `canCommit` is false. */
export function actionCardDeniedReason(view: ActionCardView): string | undefined {
  switch (view.kind) {
    case "agent:create":
      return m.action_card_denied_agent_create();
    case "channel:add_member":
      return m.action_card_denied_add_member({ channel: view.channel.displayName });
    case "app:grant_agent":
      return m.app_card_denied_reason();
    case "app:register":
      return m.app_register_card_denied_reason();
    case "app:recover_owner":
      return m.app_recover_card_denied_reason();
    case "page:fill":
      return m.action_card_denied_page_fill();
    case "desktop:takeover":
      return m.action_card_denied_desktop_takeover();
    default:
      return undefined;
  }
}

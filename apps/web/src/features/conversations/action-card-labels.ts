import {
  CpuChip01 as Cpu,
  Hash01 as Hash,
  Key01 as Key,
  List,
  Monitor01 as Monitor,
  UserPlus01 as UserPlus,
} from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";

/** Icon for the card header by kind. */
export function actionCardIcon(kind: ActionCardView["kind"]) {
  switch (kind) {
    case "channel:create":
      return Hash;
    case "agent:create":
      return Cpu;
    case "desktop:takeover":
      return Monitor;
    case "choice":
      return List;
    case "page:fill":
    case "app:grant_agent":
    case "app:register":
    case "app:recover_owner":
      return Key;
    default:
      return UserPlus;
  }
}

/** Title shown in the card header. */
export function actionCardTitle(view: ActionCardView): string {
  switch (view.kind) {
    case "page:fill":
      return m.action_card_title_page_fill();
    case "desktop:takeover":
      return m.action_card_title_desktop_takeover();
    case "choice":
      return m.action_card_title_choice();
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

/** Primary commit button label while pending. */
export function actionCardCommitLabel(view: ActionCardView, approving: boolean): string {
  switch (view.kind) {
    case "page:fill":
      return approving ? m.action_card_page_fill_filling() : m.action_card_commit_page_fill();
    case "desktop:takeover":
      return m.action_card_commit_desktop_takeover();
    case "channel:create":
      return m.action_card_commit_channel_create();
    case "agent:create":
      return m.action_card_commit_agent_create();
    case "app:grant_agent":
      return approving ? m.app_card_approving() : m.agent_apps_approve();
    case "app:register":
      return approving ? m.app_register_card_committing() : m.app_register_card_commit();
    case "app:recover_owner":
      return approving ? m.app_recover_card_committing() : m.app_recover_card_commit();
    default:
      return m.action_card_commit_add_member();
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
    case "choice":
      return m.action_card_denied_choice();
    default:
      return undefined;
  }
}

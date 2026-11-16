import { Maximize01, Minimize01 } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { HEADER_ICON_CLASS } from "./conversation-header-tabs";
import type { FocusedPanel } from "./conversation-focus-model";
import { useConversationFocus } from "./conversation-focus";

/** A panel's full screen toggle, from `lg` where the panels stand side by side; none outside the
 * chat page. */
export function ConversationFocusButton({ panel = "chat" }: { panel?: FocusedPanel }) {
  const focus = useConversationFocus();
  if (!focus) return null;
  const active = focus.focused === panel;
  return (
    <ButtonUtility
      icon={active ? Minimize01 : Maximize01}
      size="sm"
      color="tertiary"
      tooltip={active ? m.doc_exit_fullscreen() : m.doc_fullscreen()}
      className={cx("max-lg:hidden", panel === "chat" && HEADER_ICON_CLASS)}
      onClick={() => focus.toggle(panel)}
    />
  );
}

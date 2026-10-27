import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ArrowLeft } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** The width from which a list sits beside its conversation; below it the conversation takes the
 * list's place, with a back arrow to it. */
export type ListBesideFrom = "md" | "lg";

/** Each width's classes, written out whole for Tailwind: the list, hidden while a conversation
 * takes its place; what shows only then (the back arrow); the pane, with no divider then. */
export const LIST_BESIDE_CLASSES = {
  md: { list: "max-md:hidden", narrowOnly: "md:hidden", pane: "max-md:border-l-0" },
  lg: { list: "max-lg:hidden", narrowOnly: "lg:hidden", pane: "max-lg:border-l-0" },
} satisfies Record<ListBesideFrom, { list: string; narrowOnly: string; pane: string }>;

/** The conversation list's controls for the panes beside it. Its own module so a pending or empty
 * pane can show the back button without loading the directory, realtime and dialogs behind
 * `conversation-navigation`. */
export const ConversationListContext = createContext<{
  showList: () => void;
  /** Hides the list and reveals the detail pane. Called when a directory row is chosen, so a tap
   * opens the conversation even when the URL does not change (the row that is already current). */
  closeList: () => void;
  detailVisible: boolean;
  /** The back button's name, when the list is not Chat's conversations. */
  backLabel?: string;
  listBesideFrom: ListBesideFrom;
} | null>(null);

/**
 * The list controls of a page whose list stays mounted under its open conversation (Activity,
 * Search): nothing closes the list, and the back arrow closes the conversation (`onClose`).
 */
export function MountedListControls({
  listBesideFrom,
  backLabel,
  onClose,
  children,
}: {
  listBesideFrom: ListBesideFrom;
  backLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const controls = useMemo(
    () => ({
      showList: onClose,
      closeList: () => {},
      detailVisible: true,
      backLabel,
      listBesideFrom,
    }),
    [onClose, backLabel, listBesideFrom],
  );
  return <ConversationListContext value={controls}>{children}</ConversationListContext>;
}

export function ConversationListButton() {
  const navigation = useContext(ConversationListContext);
  if (!navigation) return null;
  return (
    <ButtonUtility
      icon={ArrowLeft}
      size="sm"
      color="tertiary"
      aria-label={navigation.backLabel ?? m.conversation_back_to_list()}
      onClick={navigation.showList}
      className={cx("-ml-2 shrink-0", LIST_BESIDE_CLASSES[navigation.listBesideFrom].narrowOnly)}
    />
  );
}

/**
 * A conversation pane's header bar with the back button to the list, where the loaded
 * conversation's header stands, so the arrow does not move once the conversation loads.
 */
export function ConversationBackHeader({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header
      className={cx(
        "flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 md:px-6",
        className,
      )}
    >
      <ConversationListButton />
      {children}
    </header>
  );
}

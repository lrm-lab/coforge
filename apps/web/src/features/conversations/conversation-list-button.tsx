import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ArrowLeft } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export type ListBesideFrom = "md" | "lg";

export const LIST_BESIDE_CLASSES = {
  md: { list: "max-md:hidden", narrowOnly: "md:hidden", pane: "max-md:border-s-0" },
  lg: { list: "max-lg:hidden", narrowOnly: "lg:hidden", pane: "max-lg:border-s-0" },
} satisfies Record<ListBesideFrom, { list: string; narrowOnly: string; pane: string }>;

export const ConversationListContext = createContext<{
  showList: () => void;
  closeList: () => void;
  detailVisible: boolean;
  listVisible: boolean;
  shouldRevealCurrentRow?: () => boolean;
  backLabel?: string;
  listBesideFrom: ListBesideFrom;
} | null>(null);

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
      listVisible: true,
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
      className={cx(
        "-ms-2 shrink-0 *:data-icon:rtl:rotate-180 any-pointer-coarse:size-11",
        LIST_BESIDE_CLASSES[navigation.listBesideFrom].narrowOnly,
      )}
    />
  );
}

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

import type { ReactNode } from "react";
import type { PopoverProps } from "react-aria-components";

import { Popconfirm } from "#src/components/ui/popconfirm";
import { m } from "#src/paraglide/messages";

export function DeclineQuestion({
  asker,
  questions,
  placement,
  onDecline,
  fallbackFocus,
  children,
}: {
  asker: string;
  questions: number;
  placement: PopoverProps["placement"];
  onDecline: () => Promise<void>;
  fallbackFocus?: () => HTMLElement | null | undefined;
  children: ReactNode;
}) {
  return (
    <Popconfirm
      title={
        questions > 1
          ? m.question_card_decline_title_many({ count: questions })
          : m.question_card_decline_title_one()
      }
      description={m.question_card_decline_body({ name: asker })}
      cancelLabel={m.question_card_keep_answering()}
      confirmLabel={m.question_card_decline()}
      pendingLabel={m.question_card_sending()}
      errorMessage={m.question_card_send_failed()}
      tone="final"
      placement={placement}
      fallbackFocus={fallbackFocus}
      onConfirm={onDecline}
    >
      {children}
    </Popconfirm>
  );
}

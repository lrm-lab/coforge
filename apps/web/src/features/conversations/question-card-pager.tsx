import { ChevronLeft, ChevronRight } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

export function QuestionPager({
  tab,
  total,
  onTurn,
}: {
  tab: number;
  total: number;
  onTurn: (tab: number) => void;
}) {
  return (
    <span className="-ml-2 flex items-center tabular-nums">
      <ButtonUtility
        data-question-page="prev"
        size="xs"
        color="tertiary"
        icon={ChevronLeft}
        tooltip={m.question_card_prev_question()}
        className="pointer-coarse:size-10"
        isDisabled={tab === 0}
        onClick={() => onTurn(tab - 1)}
      />
      <span data-question-pager="" className="px-0.5">
        {m.question_card_pager({ index: tab + 1, total })}
      </span>
      <ButtonUtility
        data-question-page="next"
        size="xs"
        color="tertiary"
        icon={ChevronRight}
        tooltip={m.question_card_next_question()}
        className="pointer-coarse:size-10"
        isDisabled={tab === total - 1}
        onClick={() => onTurn(tab + 1)}
      />
    </span>
  );
}

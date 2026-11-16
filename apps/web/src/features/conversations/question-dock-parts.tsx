import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Check } from "@untitledui/icons";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { clockLabel } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { isApplePlatform } from "#src/lib/platform";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { DockMessage } from "./question-card-host";
import {
  answered,
  answerText,
  type DockQuestion,
  type Draft,
  type Drafts,
} from "./question-card-model";

/** A key as the dock's hints and rows show it. */
export function Key({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-grid h-4.5 min-w-4.5 place-items-center rounded-sm bg-primary px-1 font-body text-xs/4 text-secondary shadow-[inset_0_0_0_1px_var(--color-border-secondary),0_1px_0_var(--color-border-secondary)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** The modifier the platform calls Alt. Read when called: the dock renders only on the client,
 * after a person opens it. */
export function altKey() {
  return isApplePlatform() ? "⌥" : "Alt ";
}

/** The dock's top bar: who asked, when, then the bar's own controls. */
export function DockTop({ message, children }: { message: DockMessage; children?: ReactNode }) {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-secondary pr-2 pl-4 max-sm:h-12">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-primary">
        <ActorAvatar
          size="xs"
          presence={false}
          agentId={message.senderAgentId}
          userId={message.senderUserId}
          name={message.senderName}
          src={message.senderAvatarUrl}
        />
        <span className="flex min-w-0 gap-1.5 whitespace-nowrap">
          <span className="truncate">{message.senderName}</span>
          <time className="font-normal text-quaternary tabular-nums">
            {clockLabel(message.createdAt, getLocale(), timeFormat, timeZone)}
          </time>
        </span>
      </div>
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** The questions of a card as tabs, each marked hollow until answered (numbers belong to the
 * options, which they pick), then the review. */
export function DockTabs({
  questions,
  drafts,
  tab,
  review,
  onTurn,
  tabsRef,
}: {
  questions: DockQuestion[];
  drafts: Drafts;
  tab: number;
  /** The review's tab, when the card has one. */
  review?: number;
  onTurn: (tab: number) => void;
  tabsRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tabClass = (current: boolean) =>
    cn(
      "flex h-7 max-w-42 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-focus-ring focus-visible:outline-2 max-sm:h-9",
      current ? "bg-secondary font-medium text-primary" : "text-tertiary hover:bg-primary_hover",
    );
  return (
    <div
      ref={tabsRef}
      aria-label={m.dock_questions()}
      role="group"
      className="flex shrink-0 scroll-px-6 gap-1 overflow-x-auto px-3 pt-2 [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [scrollbar-width:none]"
    >
      {questions.map((question, index) => (
        <AriaButton
          key={question.id}
          data-dock-tab={index}
          aria-current={index === tab ? "step" : undefined}
          onPress={() => onTurn(index)}
          className={tabClass(index === tab)}
        >
          <Dot on={answered(drafts[question.id])} />
          <span className="truncate">{question.prompt}</span>
        </AriaButton>
      ))}
      {review !== undefined && (
        <AriaButton
          data-dock-tab={review}
          aria-current={tab === review ? "step" : undefined}
          onPress={() => onTurn(review)}
          className={tabClass(tab === review)}
        >
          {m.dock_review()}
        </AriaButton>
      )}
    </div>
  );
}

/** A question's mark, in the stream and on its tab: hollow until it has an answer. */
export function Dot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        on ? "bg-fg-secondary" : "ring-[1.5px] ring-fg-quaternary ring-inset",
      )}
    />
  );
}

/** An option's tick: a circle for one pick, a box for several. */
export function Mark({ on, many }: { on: boolean; many: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-px grid size-4.5 shrink-0 place-items-center text-white transition-[background-color,box-shadow] duration-100",
        many ? "rounded-[0.3125rem]" : "rounded-full",
        on ? "bg-fg-primary" : "shadow-[inset_0_0_0_1.5px_var(--color-border-primary)]",
      )}
    >
      <Check
        className={cn(
          "size-3 transition-[opacity,scale] duration-150",
          on ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      />
    </span>
  );
}

/** A row the arrow keys can stand on: tinted while highlighted (keys in use) or under a mouse; a
 * finger gets a tint only while pressing, since a lasting one would read as a pick. */
export const DOCK_ROW =
  "flex w-full shrink-0 items-start gap-3 rounded-lg p-2 text-left text-sm min-h-9 cursor-pointer pointer-fine:hover:bg-secondary active:bg-secondary max-sm:min-h-12 max-sm:py-3";

/** A question and its answer, or Skipped, along one dock row: the review before sending and the
 * receipt after. */
export function AnswerLine({ question, draft }: { question: DockQuestion; draft?: Draft }) {
  const words = answerText(question, draft).join(m.question_card_answer_separator());
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-tertiary">{question.prompt}</span>
      <span
        className={cn(
          "line-clamp-3 max-w-[55%] text-right wrap-anywhere",
          words ? "font-medium text-primary" : "text-quaternary",
        )}
      >
        {words || m.question_card_skipped()}
      </span>
    </>
  );
}

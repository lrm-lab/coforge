import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "#src/components/base/buttons/button";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { isImeComposing } from "#src/lib/ime";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { focusDraftEnd } from "./composer-field";
import { useQuestionCards, useQuestionDrafts } from "./question-card-host";
import { cardKey, firstPick, goOn, type CardKeyAction } from "./question-card-keys";
import { answered, cardQuestions, type AskingView, type Draft } from "./question-card-model";
import { QuestionOptions } from "./question-card-options";
import { DeclineQuestion } from "./question-card-decline";
import { QuestionPager } from "./question-card-pager";

const TURN_AFTER_PICK_MS = 260;

export function QuestionAsk({
  view,
  asker,
  status,
  due,
  tab,
  setTab,
  kbd,
  setKbd,
  onHandled,
  focusAfter,
}: {
  view: AskingView;
  tab: number;
  setTab: (tab: number) => void;
  kbd: boolean;
  setKbd: (kbd: boolean) => void;
  asker: string;
  status: ReactNode;
  due?: string;
  onHandled: () => void;
  focusAfter: () => HTMLElement | null | undefined;
}) {
  const cards = useQuestionCards();
  const [drafts, setDraft] = useQuestionDrafts(view);
  const readOnly = !view.canCommit;
  const questions = useMemo(() => cardQuestions(view), [view]);
  const tabNow = useRef(tab);
  tabNow.current = tab;
  const [hi, setHi] = useState(() => firstPick({ questions, drafts }, 0));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const tallest = useRef({ width: 0, height: 0 });
  const otherRef = useRef<HTMLInputElement | null>(null);
  const turnTimer = useRef<number | undefined>(undefined);
  const size = useDialogControlSize();
  const coarse = useCoarsePointer();
  const question = questions[tab]!;
  const draft = drafts[question.id];
  const several = questions.length > 1;
  const last = tab === questions.length - 1;
  const anyAnswered = questions.some((each) => answered(drafts[each.id]));
  const keyState = { questions, drafts, tab, hi, kbd, readOnly };
  const otherRow = question.other ? question.options.length : -1;
  const listId = `${useId()}-q${tab}`;

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    page.style.minHeight = "";
    if (!several || coarse) return;
    const width = page.offsetWidth;
    if (width !== tallest.current.width) tallest.current = { width, height: 0 };
    tallest.current.height = Math.max(tallest.current.height, page.offsetHeight);
    page.style.minHeight = `${tallest.current.height}px`;
  }, [tab, several, coarse]);
  useLayoutEffect(() => {
    if (!kbd) return;
    const active = document.activeElement;
    if (hi === otherRow) otherRef.current?.focus({ preventScroll: true });
    else if (active instanceof HTMLInputElement && rootRef.current?.contains(active))
      list()?.focus({ preventScroll: true });
    rootRef.current
      ?.querySelector("[data-question-options] [data-hi]")
      ?.scrollIntoView({ block: "nearest" });
  }, [tab, hi, kbd, otherRow]);

  useEffect(() => {
    cardRef.current = rootRef.current?.closest<HTMLElement>("[data-question-card]") ?? null;
    return () => window.clearTimeout(turnTimer.current);
  }, []);

  function list() {
    return rootRef.current?.querySelector<HTMLElement>("[data-question-options]");
  }

  function turn(to: number) {
    window.clearTimeout(turnTimer.current);
    const keep = rootRef.current?.contains(document.activeElement);
    setTab(to);
    setHi(firstPick({ questions, drafts }, to));
    if (keep) requestAnimationFrame(() => list()?.focus({ preventScroll: true }));
  }

  async function submit(patch?: Record<string, Draft>) {
    if (sending) return;
    setSending(true);
    setError("");
    const keys = rootRef.current?.contains(document.activeElement);
    onHandled();
    try {
      await cards!.submit(view, { ...drafts, ...patch });
      if (keys) requestAnimationFrame(() => focusAfter()?.focus({ preventScroll: true }));
    } catch {
      setError(m.question_card_send_failed());
    } finally {
      setSending(false);
    }
  }

  function choose(id: string) {
    const draft = { selection: [id], text: "" };
    setDraft(question.id, draft);
    return { [question.id]: draft };
  }

  function pick(row: number) {
    setHi(row);
    if (readOnly || row >= question.options.length) return;
    const id = question.options[row]!.id;
    if (question.select === "many") {
      const selection = draft?.selection ?? [];
      return setDraft(question.id, {
        selection: selection.includes(id)
          ? selection.filter((picked) => picked !== id)
          : [...selection, id],
        text: draft?.text ?? "",
      });
    }
    const patch = choose(id);
    if (!several) return void submit(patch);
    if (last) return;
    const from = tab;
    window.clearTimeout(turnTimer.current);
    turnTimer.current = window.setTimeout(() => {
      if (tabNow.current === from) turn(from + 1);
    }, TURN_AFTER_PICK_MS);
  }

  function composer() {
    const field = rootRef.current
      ?.closest("[data-conversation-pane]")
      ?.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
    return field?.getClientRects().length ? field : null;
  }

  function act(action: CardKeyAction) {
    switch (action.do) {
      case "leave":
        if (coarse) return rootRef.current?.querySelector<HTMLElement>(":focus")?.blur();
        return focusDraftEnd(composer());
      case "switch":
        return cards?.focusWaiting(action.by, view.messageId);
      case "showKeys":
        return setKbd(true);
      case "view":
        if (action.tab !== tab) return turn(action.tab);
        return setHi(action.hi);
      case "pick":
        return pick(action.row);
      case "confirm": {
        const patch = choose(question.options[action.row]!.id);
        const next = goOn({ ...keyState, drafts: { ...drafts, ...patch } });
        if (next.do === "submit") return void submit(patch);
        return act(next);
      }
      case "submit":
        return void submit();
      default:
        return;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) return;
    const target = event.target as HTMLElement;
    const action = cardKey(keyState, {
      key: event.key,
      alt: event.altKey,
      mod: event.metaKey || event.ctrlKey,
      typing: target instanceof HTMLInputElement,
      onControl: Boolean(target.closest("button, a")),
    });
    if (action.do === "pass" || isImeComposing(event)) return;
    if (action.do === "leave" && !coarse && !composer()) return;
    event.preventDefault();
    event.stopPropagation();
    act(action);
  }

  const showSend = several ? last : question.select === "many" || Boolean(draft?.text.trim());
  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      onPointerMove={(event) => {
        if (kbd && event.pointerType === "mouse") setKbd(false);
      }}
      className="flex flex-1 flex-col"
    >
      <div ref={pageRef} className="flex flex-col">
        <p
          data-question-prompt=""
          className={cn(
            "px-3 pt-2 pb-1.5 text-sm wrap-anywhere text-primary",
            several ? "font-medium" : "font-semibold",
          )}
        >
          {question.prompt}
        </p>
        <QuestionOptions
          key={question.id}
          id={listId}
          question={question}
          draft={draft}
          mode={readOnly ? "view" : "live"}
          hi={hi}
          kbd={kbd}
          otherRef={(element) => {
            otherRef.current = element;
          }}
          onHover={setHi}
          onPick={pick}
          onDraft={(next) => setDraft(question.id, next)}
        />
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 pt-1 pl-3 text-xs text-quaternary">
        {due && (
          <span data-question-due="" className="whitespace-nowrap max-sm:basis-full max-sm:pt-1">
            {due}
          </span>
        )}
        {several && <QuestionPager tab={tab} total={questions.length} onTurn={turn} />}
        {readOnly && (
          <span data-question-status="" className="flex min-w-0 max-w-full items-center">
            {status}
          </span>
        )}
        {error && (
          <p role="alert" className="min-w-0 text-error-primary">
            {error}
          </p>
        )}
        {!readOnly && (
          <span className="ml-auto flex min-h-10 items-center gap-1 py-1 pr-1 max-sm:min-h-13">
            <DeclineQuestion
              asker={asker}
              questions={questions.length}
              placement="top end"
              fallbackFocus={() => cardRef.current}
              onDecline={async () => {
                onHandled();
                await cards!.decline(view);
              }}
            >
              <Button data-question-decline="" size={size} color="link-gray" className="px-2">
                {m.question_card_decline()}
              </Button>
            </DeclineQuestion>
            {showSend ? (
              <Button
                data-question-send=""
                size={size}
                color="primary"
                isDisabled={!anyAnswered}
                isLoading={sending}
                showTextWhileLoading
                onPress={() => void submit()}
              >
                {sending ? m.question_card_sending() : m.question_card_send()}
              </Button>
            ) : (
              several && (
                <Button
                  data-question-next=""
                  size={size}
                  color="secondary"
                  onPress={() => turn(tab + 1)}
                >
                  {answered(draft) ? m.question_card_next() : m.question_card_skip()}
                </Button>
              )
            )}
          </span>
        )}
        {readOnly && <span className="min-h-10 max-sm:min-h-13" />}
      </div>
    </div>
  );
}

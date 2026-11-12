import { CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";

import type { ActionCardView } from "#src/server/conversations/action-cards.server";

export type ChoiceView = Extract<ActionCardView, { kind: "choice" }>;
export type QuestionsView = Extract<ActionCardView, { kind: "questions" }>;
/** A card the dock answers: an Agent's one question (`choice`) or several (`questions`). */
export type AskingView = ChoiceView | QuestionsView;
export type DockQuestion = QuestionsView["questions"][number];

/** One question's answer as it is being given: the options ticked, and the person's own words. */
export type Draft = { selection: string[]; text: string };
export type Drafts = Record<string, Draft>;

/** One question's answer, as `commitQuestionsActionCard` takes it. */
export type QuestionsAnswer = { questionId: string; selection: string[]; text?: string };

/** What the dock sends for a card: the server's own shape for each kind. */
type Submission =
  | { kind: "choice"; optionId: string; text?: string }
  | { kind: "questions"; answers: QuestionsAnswer[] };

/** The id a choice card's one question goes by in the dock and its kept drafts. */
const CHOICE_QUESTION_ID = "choice";

export function isAskingView(view: ActionCardView | undefined): view is AskingView {
  return view?.kind === "choice" || view?.kind === "questions";
}

/** Whether the card is the viewer's to answer: while it waits, whether they may; after, whether
 * it asked them. */
export function isMine(view: AskingView) {
  return view.state === "pending" ? view.canCommit : Boolean(view.asked?.isViewer);
}

/** The card's questions as the dock asks them; a choice card is one single-pick question. */
export function dockQuestions(view: AskingView): DockQuestion[] {
  if (view.kind === "questions") return view.questions;
  return [
    {
      id: CHOICE_QUESTION_ID,
      prompt: view.prompt,
      select: "one",
      options: view.options,
      ...(view.other ? { other: view.other } : {}),
    },
  ];
}

/** Whether a draft answers its question: an option ticked, or words of the person's own. */
export function answered(draft: Draft | undefined): boolean {
  if (!draft) return false;
  return (
    draft.selection.some((id) => id !== CHOICE_OTHER_OPTION_ID) || draft.text.trim().length > 0
  );
}

/** Kept drafts as the card asks now: a question, option or own-words row it no longer has is
 * dropped, so an answer is never sent for something the person cannot see. */
export function fitDrafts(questions: DockQuestion[], drafts: Drafts): Drafts {
  const fitted: Drafts = {};
  for (const question of questions) {
    const draft = drafts[question.id];
    if (!draft) continue;
    const offered = new Set(question.options.map((option) => option.id));
    const selection = draft.selection.filter((id) => offered.has(id));
    const text = question.other ? draft.text : "";
    if (selection.length || text) fitted[question.id] = { selection, text };
  }
  return fitted;
}

/** An answer as words: the labels ticked, in the order ticked, then the person's own. */
export function answerText(question: DockQuestion, draft: Draft | undefined): string[] {
  if (!draft) return [];
  const labels = draft.selection.flatMap((id) => {
    const option = question.options.find((candidate) => candidate.id === id);
    return option ? [option.label] : [];
  });
  const text = draft.text.trim();
  return text ? [...labels, text] : labels;
}

/** The answers to send, or nothing when no question is answered. A question left unanswered is
 * left out; the server records it skipped. */
export function submission(view: AskingView, drafts: Drafts): Submission | undefined {
  const answers = dockQuestions(view).flatMap((question): QuestionsAnswer[] => {
    const draft = drafts[question.id];
    if (!answered(draft)) return [];
    const text = draft!.text.trim();
    const selection = draft!.selection.filter((id) => id !== CHOICE_OTHER_OPTION_ID);
    return [
      text
        ? { questionId: question.id, selection: [...selection, CHOICE_OTHER_OPTION_ID], text }
        : { questionId: question.id, selection },
    ];
  });
  if (!answers.length) return undefined;
  if (view.kind === "questions") return { kind: "questions", answers };
  const [answer] = answers;
  // A single pick: the person's own words replace the option, never sit beside it.
  return answer!.text
    ? { kind: "choice", optionId: CHOICE_OTHER_OPTION_ID, text: answer!.text }
    : { kind: "choice", optionId: answer!.selection[0]! };
}

/** The answers a card was given, as drafts, to show where they were given; none until it is. */
export function givenAnswers(view: AskingView): Drafts {
  if (view.kind === "choice") {
    const result = view.result;
    if (!result) return {};
    return {
      [CHOICE_QUESTION_ID]:
        result.optionId === CHOICE_OTHER_OPTION_ID
          ? { selection: [], text: result.text ?? "" }
          : { selection: [result.optionId], text: "" },
    };
  }
  return Object.fromEntries(
    (view.result?.answers ?? []).map((answer) => [
      answer.questionId,
      {
        selection: answer.selection
          .map((pick) => pick.optionId)
          .filter((id) => id !== CHOICE_OTHER_OPTION_ID),
        text: answer.selection.find((pick) => pick.optionId === CHOICE_OTHER_OPTION_ID)?.text ?? "",
      },
    ]),
  );
}

/** After `answeredId` is sent, the card to offer next: the first still waiting below it in the
 * stream, else the latest still waiting. */
export function nextWaiting(
  waitingIds: readonly string[],
  streamIds: readonly string[],
  answeredId: string,
): string | undefined {
  const below = streamIds.slice(streamIds.indexOf(answeredId) + 1);
  return below.find((id) => waitingIds.includes(id)) ?? waitingIds.at(-1);
}

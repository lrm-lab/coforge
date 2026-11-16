import { answered, type DockQuestion, type Drafts } from "./question-card-model";

/** Where the dock stands when a key comes: the question (or the review after the last), the row
 * the arrow keys stand on, and whether that highlight is shown yet. */
export type DockKeyState = {
  questions: DockQuestion[];
  drafts: Drafts;
  tab: number;
  hi: number;
  /** The highlight is drawn: keys have been used since the dock opened, or it opened by key. */
  kbd: boolean;
  /** Someone else's card, to look through. */
  readOnly: boolean;
};

type DockKeyInput = {
  key: string;
  alt: boolean;
  /** Ctrl or Meta held: the browser's and the app's shortcuts, never the dock's. */
  mod: boolean;
  /** The key went to the person's own-words field. */
  typing: boolean;
  /** The key went to a button of the dock's own (a tab, Skip, Next, Not answering). */
  onControl: boolean;
};

export type DockKeyAction =
  /** Not the dock's key: leave it to the focused element and the browser. */
  | { do: "pass" }
  /** The dock's key, with nothing to do from here (the first question's ←). */
  | { do: "stay" }
  | { do: "close" }
  | { do: "switch"; by: 1 | -1 }
  | { do: "showKeys" }
  | { do: "view"; tab: number; hi: number }
  /** Tick or untick `row` (the own-words row: go type in it). */
  | { do: "pick"; row: number }
  /** Take option `row` as the answer to a one-pick question, then go on. */
  | { do: "confirm"; row: number }
  | { do: "submit" };

/** Whether a card shows a review tab after its questions: more than one question, to answer. */
export function reviewTab(questions: DockQuestion[], readOnly: boolean): number | undefined {
  return questions.length > 1 && !readOnly ? questions.length : undefined;
}

/** The row the highlight starts on in a question: its first pick, else the first option. */
export function firstPick(state: Pick<DockKeyState, "questions" | "drafts">, tab: number) {
  const question = state.questions[tab];
  const picked = question && state.drafts[question.id]?.selection[0];
  const at = picked ? question.options.findIndex((option) => option.id === picked) : -1;
  return Math.max(at, 0);
}

/** How many rows the arrow keys go round on this tab. */
function rowCount(state: DockKeyState, review: boolean) {
  if (review) return state.questions.length;
  const question = state.questions[state.tab]!;
  return question.options.length + (question.other ? 1 : 0);
}

/** Going on from a question: the next one (the review after the last), or on a card of one
 * question, sending it once answered. */
export function goOn(state: DockKeyState): DockKeyAction {
  if (state.questions.length === 1)
    return answered(state.drafts[state.questions[0]!.id]) ? { do: "submit" } : { do: "stay" };
  return turnTo(state, state.tab + 1);
}

/** Turning to question `tab` (clamped), at its first pick. */
export function turnTo(state: DockKeyState, tab: number): DockKeyAction {
  const last = reviewTab(state.questions, state.readOnly) ?? state.questions.length - 1;
  const to = Math.max(0, Math.min(last, tab));
  return to === state.tab ? { do: "stay" } : { do: "view", tab: to, hi: firstPick(state, to) };
}

/** What a key does in the dock (Frank, 11-12): ↑↓ move the highlight (the first only shows it),
 * ←→ turn the question, a digit picks its row, Space ticks the highlighted one, Enter takes it and
 * goes on (or sends, from the review), Esc puts the card off, Alt+↑↓ turns to another card. */
export function dockKey(state: DockKeyState, input: DockKeyInput): DockKeyAction {
  const { key } = input;
  if (key === "Escape") return { do: "close" };
  if (input.alt && (key === "ArrowDown" || key === "ArrowUp"))
    return { do: "switch", by: key === "ArrowDown" ? 1 : -1 };
  if (input.mod || input.alt) return { do: "pass" };
  if ((key === "Enter" || key === " ") && input.onControl) return { do: "pass" };
  const review = state.tab === reviewTab(state.questions, state.readOnly);
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (!state.kbd) return { do: "showKeys" };
    const rows = rowCount(state, review);
    return {
      do: "view",
      tab: state.tab,
      hi: (state.hi + (key === "ArrowDown" ? 1 : -1) + rows) % rows,
    };
  }
  if (input.typing) return key === "Enter" ? goOn(state) : { do: "pass" };
  if (key === "ArrowRight" || key === "ArrowLeft")
    return turnTo(state, state.tab + (key === "ArrowRight" ? 1 : -1));
  if (state.readOnly) return { do: "pass" };
  if (review) {
    if (key !== "Enter") return { do: "pass" };
    return state.questions.some((question) => answered(state.drafts[question.id]))
      ? { do: "submit" }
      : { do: "stay" };
  }
  const question = state.questions[state.tab]!;
  const digit = Number(key);
  if (key.length === 1 && Number.isInteger(digit) && digit >= 1 && digit <= rowCount(state, false))
    return { do: "pick", row: digit - 1 };
  if (key === " ") return { do: "pick", row: state.hi };
  if (key !== "Enter") return { do: "pass" };
  if (!state.kbd && !answered(state.drafts[question.id])) return { do: "showKeys" };
  if (question.select === "one" && state.hi < question.options.length)
    return state.kbd ? { do: "confirm", row: state.hi } : goOn(state);
  return goOn(state);
}

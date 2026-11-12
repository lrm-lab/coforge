/**
 * The three ways a `choice` or `questions` card ends for the Agent that asked it — answered,
 * declined, expired — read as one sentence shape: who, what happened, which card, where. Every
 * body an Agent gets about a card's outcome (the live wake and the offline replay) is built here.
 */

export type CardOutcomeSubject = {
  /** `choice`, `questions`, or any other card kind (read as "action card"). */
  kind: string;
  /** The card's own prompt; a questions card may have none. */
  prompt?: string;
  target: string;
};

/** How a person reads as the subject of an outcome; a user row that is gone stays anonymous. */
export const cardPerson = (username: string | null | undefined): string =>
  username ? `@${username}` : "Someone";

function cardNoun({ kind, prompt }: CardOutcomeSubject): string {
  const noun = kind === "choice" || kind === "questions" ? kind : "action card";
  return prompt ? `${noun} "${prompt}"` : noun;
}

/** `<who> answered your choice "<prompt>" in <target>`, to which the answer is appended. */
export const cardAnsweredHead = (who: string, subject: CardOutcomeSubject): string =>
  `${who} answered your ${cardNoun(subject)} in ${subject.target}`;

export const cardDeclinedBody = (who: string, subject: CardOutcomeSubject): string =>
  `${who} declined your ${cardNoun(subject)} in ${subject.target}.`;

/** `who` is absent for a card that never named the person it asked. */
export const cardExpiredBody = (who: string | undefined, subject: CardOutcomeSubject): string =>
  `${who ? `${who} did not answer` : "Nobody answered"} your ${cardNoun(subject)} in ${subject.target} before it expired.`;

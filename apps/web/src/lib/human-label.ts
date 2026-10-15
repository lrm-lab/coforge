/** The name shown for a person with no name to show: an account the sign-in provider told us
 * nothing about, until its person confirms a name at first sign-in. */
export const UNNAMED_PERSON_NAME = "Unnamed";

/** The names a person can be called by. `username` only orders people shown alike
 * (`compareHumanLabels`); it is never shown. */
export type HumanNames = {
  displayName?: string | null;
  username: string;
};

/**
 * The one name every surface shows for a person: their display name, which every account has
 * (Slack requires a name the same way), trimmed. A person is never shown by their username; a
 * missing or blank name, which only a row read without it can produce, reads as
 * `UNNAMED_PERSON_NAME`.
 *
 * Pass the row (`humanLabel(row.user)`) rather than picking fields, so a caller changes only
 * when the rule gains a name. An Agent has its own rule (`displayName || name`); this is not it.
 */
export function humanLabel(names: Pick<HumanNames, "displayName">): string {
  return names.displayName?.trim() || UNNAMED_PERSON_NAME;
}

// Base sensitivity: "Alex" and "alex" are one name to a reader, so the username settles the tie.
const labelCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Orders people by the name they are shown by, in the host's locale; the (unique) username
 * breaks a tie so the order is the same on every read. */
export function compareHumanLabels(left: HumanNames, right: HumanNames): number {
  return (
    labelCollator.compare(humanLabel(left), humanLabel(right)) ||
    (left.username < right.username ? -1 : left.username > right.username ? 1 : 0)
  );
}

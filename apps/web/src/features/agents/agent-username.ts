import { AGENT_NAME_MAX_LENGTH, freeAgentName } from "@lrm/coforge-sdk/internal";

/**
 * What a person types, turned into the username form (`AGENT_NAME_PATTERN`) as they type, so the
 * field never holds a value the server refuses: lowercase, accents dropped, spaces and underscores
 * become one hyphen, anything else is removed. A trailing hyphen stays so the next word can follow;
 * `finishedAgentUsername` drops it once they leave the field.
 */
export function typedAgentUsername(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .slice(0, AGENT_NAME_MAX_LENGTH);
}

export function finishedAgentUsername(text: string): string {
  return typedAgentUsername(text).replace(/-+$/, "");
}

/** Usernames the create form suggests, after people who shaped computing. */
const SUGGESTED_USERNAMES = [
  "ada",
  "alan",
  "grace",
  "linus",
  "margaret",
  "dennis",
  "barbara",
  "edsger",
  "donald",
  "katherine",
  "hedy",
  "guido",
  "frances",
  "radia",
  "leslie",
  "niklaus",
  "annie",
  "claude",
  "john",
  "dorothy",
];

/** A suggested username for a new Agent, never the one it replaces, and free while one is
 * (`availableAgentUsername`). */
export function randomAgentUsername(
  current?: string,
  random: () => number = Math.random,
  taken: ReadonlySet<string> = new Set(),
): string {
  const others = SUGGESTED_USERNAMES.filter((name) => name !== current);
  return availableAgentUsername(others[Math.floor(random() * others.length)]!, taken, current);
}

/**
 * `name` while no Agent has it (`taken`: lowercase handles); otherwise the next suggestion nobody
 * has, never `skip`; once every one is taken, `name` with the first free `-2`, `-3`… The same
 * `name` and `taken` always give the same answer, so a suggestion made before the directory was
 * read moves once it is, and only then.
 */
export function availableAgentUsername(
  name: string,
  taken: ReadonlySet<string>,
  skip?: string,
): string {
  if (!taken.has(name)) return name;
  const start = SUGGESTED_USERNAMES.indexOf(name) + 1;
  const order = [...SUGGESTED_USERNAMES.slice(start), ...SUGGESTED_USERNAMES.slice(0, start)];
  return order.find((other) => other !== skip && !taken.has(other)) ?? freeAgentName(name, taken);
}

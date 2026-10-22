import { AGENT_NAME_MAX_LENGTH } from "@lrm/coforge-sdk/internal";

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

/** A suggested username for a new Agent, never the one it replaces. */
export function randomAgentUsername(current?: string, random: () => number = Math.random): string {
  const choices = SUGGESTED_USERNAMES.filter((name) => name !== current);
  return choices[Math.floor(random() * choices.length)]!;
}

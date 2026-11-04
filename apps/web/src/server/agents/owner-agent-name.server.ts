import { AGENT_DISPLAY_NAME_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import { isUserLanguage } from "#src/server/db/repositories/user-preferences.repositories.server";
import type { Locale } from "#src/paraglide/runtime";

/** The language an Agent named after its owner is named in: the owner's saved interface
 * language, else the request's locale, else Chinese. */
export function ownerAgentLanguage(saved: unknown, requestLocale?: Locale): Locale {
  return isUserLanguage(saved) ? saved : (requestLocale ?? "zh-CN");
}

/**
 * `{person}{suffix}`, with the person's label cut to leave the suffix room within an Agent's
 * display name. The cut falls between characters, never inside a surrogate pair, and drops the
 * space it would leave before the suffix. The caller supplies the language's suffix and decides
 * what a blank label reads as.
 */
export function ownerAgentName(personLabel: string, suffix: string): string {
  const room = AGENT_DISPLAY_NAME_MAX_LENGTH - suffix.length;
  let person = "";
  for (const character of personLabel) {
    if (person.length + character.length > room) break;
    person += character;
  }
  return `${person.trimEnd()}${suffix}`;
}

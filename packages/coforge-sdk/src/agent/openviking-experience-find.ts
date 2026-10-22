/** ADR-0046 `experience_find`: skill_card and fork experience cards. */

import type { OPENVIKING_AGENT_PROTOCOL } from "./openviking-memory";
import type { OpenVikingCitation } from "./memory-citations";

/** Kept in step with OpenViking `experience_cards.py`. */
export const EXPERIENCE_CARD_KINDS = ["skill_card", "fork"] as const;
export type ExperienceCardKind = (typeof EXPERIENCE_CARD_KINDS)[number];
export const EXPERIENCE_DELIVERABLE_KINDS = ["pdf", "docx", "xlsx", "pptx", "av", "text"] as const;
export type ExperienceDeliverableKind = (typeof EXPERIENCE_DELIVERABLE_KINDS)[number];
export const EXPERIENCE_ISSUE_KINDS = [
  "no_artifact",
  "placeholder",
  "constraint",
  "missing_section",
  "incorrect",
  "format",
  "domain",
] as const;
export type ExperienceIssueKind = (typeof EXPERIENCE_ISSUE_KINDS)[number];

export type OpenVikingExperienceFindCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "experience_find";
  operationId: string;
  query: string;
  kind?: ExperienceCardKind;
  deliverable?: ExperienceDeliverableKind;
  occupation?: string;
  issueKind?: ExperienceIssueKind;
  limit?: number;
};

export type OpenVikingExperienceFindResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "experience_find";
  operationId: string;
  duplicate: boolean;
  items: OpenVikingCitation[];
  /** The deliverable filter matched nothing and was dropped. */
  relaxed: boolean;
};

type ExperienceFindFields = Pick<
  OpenVikingExperienceFindCommand,
  "kind" | "deliverable" | "issueKind" | "occupation"
>;

function optionalChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value))
    throw new Error(
      `invalid openviking experience_find ${field}; use one of ${choices.join(", ")}`,
    );
  return value as T;
}

/** Validates the optional experience_find arguments; `command` already has a valid `query`. */
export function decodeExperienceFindFields(command: Record<string, unknown>): ExperienceFindFields {
  const kind = optionalChoice(command.kind, EXPERIENCE_CARD_KINDS, "kind");
  const deliverable = optionalChoice(
    command.deliverable,
    EXPERIENCE_DELIVERABLE_KINDS,
    "deliverable",
  );
  const issueKind = optionalChoice(command.issueKind, EXPERIENCE_ISSUE_KINDS, "issueKind");
  const occupation = command.occupation;
  if (occupation !== undefined && (typeof occupation !== "string" || !occupation.trim()))
    throw new Error("invalid openviking experience_find occupation");
  if ("targetUri" in command) throw new Error("experience_find has a fixed namespace");
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(deliverable === undefined ? {} : { deliverable }),
    ...(issueKind === undefined ? {} : { issueKind }),
    ...(occupation === undefined ? {} : { occupation }),
  };
}

export function decodeExperienceRelaxed(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid experience_find relaxed flag");
  return value;
}

/**
 * What a person mainly does, asked once in the setup wizard and saved as `UserPreference.role`.
 * Metadata for the platform assistant: it is never shown back in the UI. The CHECK constraint
 * `user_preferences_role_check` spells the same set in SQL; change both together.
 */
export const PERSON_ROLES = [
  "engineer",
  "designer",
  "product",
  "marketing",
  "research",
  "founder",
] as const;

export type PersonRole = (typeof PERSON_ROLES)[number];

export function isPersonRole(value: unknown): value is PersonRole {
  return PERSON_ROLES.includes(value as PersonRole);
}

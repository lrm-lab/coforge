import { parseCodeDestination } from "./code-destination";

/**
 * What the reset page leaves for the sign-in page it returns to, in the navigation's history state
 * (not in the URL, which would put an email or a phone number in access logs and history): that a
 * password was just set, and for which destination (the normalized email or phone number that
 * `parseCodeDestination` reads), so the page can say so and fill it in.
 */
export type PasswordUpdated = { destination: string };

declare module "@tanstack/react-router" {
  interface HistoryState {
    passwordUpdated?: PasswordUpdated;
  }
}

/** The `PasswordUpdated` a history state holds, or `undefined` when it holds none. */
export function readPasswordUpdated(state: unknown): PasswordUpdated | undefined {
  if (typeof state !== "object" || state === null || !("passwordUpdated" in state))
    return undefined;
  const value = state.passwordUpdated;
  if (typeof value !== "object" || value === null) return undefined;
  const { destination } = value as Record<string, unknown>;
  if (typeof destination !== "string" || !parseCodeDestination(destination)) return undefined;
  return { destination };
}

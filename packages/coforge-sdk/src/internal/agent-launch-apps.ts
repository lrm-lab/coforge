/**
 * The apps installed in an Agent's Workspace as its launch identity carries them (`identity.apps`
 * in the `POST /api/agent-api-keys` response) and its standing prompt names them. Web builds the
 * list with `normalizeAgentLaunchApps`; the daemon applies it again to what it receives, so the
 * prompt never depends on the server having done so.
 */

/** One installed app: publisher text only, never a secret, an access state or a URL. */
export type AgentLaunchApp = {
  key: string;
  name: string;
  description?: string;
  whenToUse?: string;
};

/** At most this many apps travel; `coforge app list` shows every one. */
export const AGENT_LAUNCH_APPS_MAX_COUNT = 20;
/** Each field's cap in code points; a cut field ends with `…`. */
export const AGENT_LAUNCH_APP_NAME_MAX_LENGTH = 80;
export const AGENT_LAUNCH_APP_DESCRIPTION_MAX_LENGTH = 200;
export const AGENT_LAUNCH_APP_WHEN_TO_USE_MAX_LENGTH = 160;
/** The standing prompt's whole Apps section stays within this many UTF-8 bytes; the apps that do
 * not fit are counted on one line instead. */
export const AGENT_LAUNCH_APPS_SECTION_MAX_BYTES = 4096;

/** A third-party app's key, which is also its OIDC `client_id`: 3 to 64 lowercase letters, digits
 * and hyphens. Never dotted, so it never names a built-in app (`system.cleaner`). */
export const APP_KEY_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;

/**
 * Publisher text as one line that cannot change the prompt around it: control characters become
 * spaces, format characters (bidi controls, zero-width characters) are removed, a backtick becomes
 * an apostrophe so no code span opens or closes, whitespace runs become one space, and the result
 * is trimmed and at most `max` code points, a cut one ending with `…`.
 */
export function normalizeAgentLaunchText(text: string, max: number): string {
  const characters = [
    ...text
      .replace(/\p{Cc}/gu, " ")
      .replace(/\p{Cf}/gu, "")
      .replaceAll("`", "'")
      .replace(/\s+/g, " ")
      .trim(),
  ];
  if (characters.length <= max) return characters.join("");
  return `${characters
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? normalizeAgentLaunchText(value, max) || undefined : undefined;
}

function normalizeAgentLaunchApp(value: unknown): AgentLaunchApp | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !APP_KEY_PATTERN.test(record.key)) return undefined;
  const name = optionalText(record.name, AGENT_LAUNCH_APP_NAME_MAX_LENGTH);
  if (!name) return undefined;
  const description = optionalText(record.description, AGENT_LAUNCH_APP_DESCRIPTION_MAX_LENGTH);
  const whenToUse = optionalText(record.whenToUse, AGENT_LAUNCH_APP_WHEN_TO_USE_MAX_LENGTH);
  return {
    key: record.key,
    name,
    ...(description ? { description } : {}),
    ...(whenToUse ? { whenToUse } : {}),
  };
}

/** The first `AGENT_LAUNCH_APPS_MAX_COUNT` valid apps, each normalised; an entry without a
 * registry key or a name is dropped on its own. */
export function normalizeAgentLaunchApps(values: readonly unknown[]): AgentLaunchApp[] {
  return values
    .map(normalizeAgentLaunchApp)
    .filter((app) => app !== undefined)
    .slice(0, AGENT_LAUNCH_APPS_MAX_COUNT);
}

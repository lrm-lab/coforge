import { isRedirectUri, text } from "./app-registration";

/**
 * Where an app is set up after it is installed: the page it declares, the one line that says what
 * the page is for, and the status an installation derives from them. Pure and client-safe;
 * `server/app-installation-setup/` enforces it.
 */

/** The longest setup page URL and description, the latter counted as code points. */
export const SETUP_URL_MAX_LENGTH = 2000;
export const SETUP_DESCRIPTION_MAX_LENGTH = 500;

/** The `errorId`s a declaration is refused with, one per field. */
export const APP_SETUP_URL_INVALID = "app-setup-url-invalid";
export const APP_SETUP_DESCRIPTION_INVALID = "app-setup-description-invalid";

/** The setup an app declares: its page (none: no setup is required) and what the page is for. */
export type AppSetupInput = { url: string | null; description: string };
export type AppSetupField = "url" | "description";

/** Whether `value` is a page an installer may be sent to: the rule of a redirect URI (https, or
 * http on loopback; canonical; no user info or fragment) within `SETUP_URL_MAX_LENGTH`. */
export const isSetupUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length <= SETUP_URL_MAX_LENGTH && isRedirectUri(value);

const descriptionCheck = text(0, SETUP_DESCRIPTION_MAX_LENGTH);

/** The declaration as stored, or the first field refused. */
export function checkSetupInput(
  value: unknown,
): { ok: true; value: AppSetupInput } | { ok: false; field: AppSetupField } {
  const given = typeof value === "object" && value !== null ? value : {};
  const url: unknown = Reflect.get(given, "url");
  if (url !== null && !isSetupUrl(url)) return { ok: false, field: "url" };
  const line = descriptionCheck(Reflect.get(given, "description"));
  return line.ok
    ? { ok: true, value: { url, description: line.value } }
    : { ok: false, field: "description" };
}

/** The `errorId` each field is refused with. */
export const APP_SETUP_ERROR_IDS: Record<AppSetupField, string> = {
  url: APP_SETUP_URL_INVALID,
  description: APP_SETUP_DESCRIPTION_INVALID,
};

/** The `errorId` of the refusal for a Workspace where `app-installation-setup` is off. */
export const APP_INSTALLATION_SETUP_OFF = "app-installation-setup-off";

/** The setup field an `APP_SETUP_ERROR_IDS` id names, or `undefined` for any other id. */
export const setupFieldOf = (errorId: string | undefined): AppSetupField | undefined =>
  (Object.keys(APP_SETUP_ERROR_IDS) as AppSetupField[]).find(
    (field) => APP_SETUP_ERROR_IDS[field] === errorId,
  );

export type SetupStatus = "not_required" | "pending" | "complete";

/** No page: not required, whatever was finished before. Else complete once the installation has
 * finished the app's current revision, and pending until then. */
export function setupStatus(setup: {
  url: string | null;
  revision: number;
  completedRevision: number | null;
}): SetupStatus {
  if (setup.url === null) return "not_required";
  return setup.completedRevision === setup.revision ? "complete" : "pending";
}

/** The page an installer opens: the declared URL with the installation, its Workspace and the
 * revision to report on, so the app knows which one it is setting up. They replace a parameter
 * of the same name the URL already has. */
export function setupLink(
  url: string,
  ids: { installationId: string; workspaceId: string; revision: number },
): string {
  const link = new URL(url);
  link.searchParams.set("installation_id", ids.installationId);
  link.searchParams.set("workspace_id", ids.workspaceId);
  link.searchParams.set("setup_revision", String(ids.revision));
  return link.href;
}

/** An app's setup as Settings shows it: what it declares (the saved page, none when no setup is
 * required) and this Workspace's installation of it, when there is one. */
export type AppSetupSummary = {
  url: string | null;
  description: string;
  installation: {
    installationId: string;
    status: SetupStatus;
    /** The page with the installation's ids, for an owner or admin to open; null for anyone else. */
    link: string | null;
    completedAt: string | null;
  } | null;
};

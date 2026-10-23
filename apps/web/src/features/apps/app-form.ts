import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { setupFieldOf, type AppSetupField, type AppSetupInput } from "./app-installation-setup";
import type { AppNotificationEventName } from "./app-notification-events";
import { APP_PERMISSIONS_CHANGED, type AppPermissionGroup } from "./app-permissions";
import {
  appInputFieldOf,
  type AppInputField,
  type AppRegistrationInput,
  type AppScope,
} from "./app-registration";

/** What each field's rule asks for, shown beside the field it refuses; a `Record` so a new field
 * cannot ship without its copy. */
export const APP_FIELD_PROBLEMS: Record<AppInputField, () => string> = {
  key: m.apps_error_key,
  name: m.apps_error_name,
  description: m.apps_error_description,
  whenToUse: m.apps_error_when_to_use,
  homepageUrl: m.apps_error_homepage,
  redirectUris: m.apps_error_redirect_uris,
  category: m.apps_error_category,
  allowedScopes: m.apps_error_scopes,
};

/** What a scope lets the app learn, as the form describes it beside the scope's name. */
export const APP_SCOPE_DESCRIPTIONS: Record<AppScope, () => string> = {
  openid: m.apps_scope_openid,
  profile: m.apps_scope_profile,
  identity: m.apps_scope_identity,
  email: m.apps_scope_email,
};

/** Whether `cause` is the refusal of a permissions change made on a declaration that has moved on. */
export function isPermissionsChanged(cause: unknown): boolean {
  return isAppErrorCode(cause, "CONFLICT") && cause.errorId === APP_PERMISSIONS_CHANGED;
}

/** What is wrong with each Installation setup field the rules refuse. */
export const SETUP_FIELD_PROBLEMS: Record<AppSetupField, () => string> = {
  url: m.apps_setup_url_error,
  description: m.apps_setup_description_error,
};

/** What the editor's Save sends: the app's fields, and the data groups and setup page it declares
 * where the editor shows them. */
export type AppEditorSubmission = {
  input: AppRegistrationInput;
  permissionGroups?: AppPermissionGroup[];
  /** The notification events subscribed to, with the groups, where `app-notifications` is on. */
  notificationEvents?: AppNotificationEventName[];
  setup?: AppSetupInput;
};

/**
 * A refused register or change as the form shows it: beside `field` when the refusal names an input
 * field (the registry's `app-<field>-invalid`, or a taken key), else in the form's notice strip,
 * with `fallback` for a failure that names nothing.
 */
export function appFormProblem(
  cause: unknown,
  fallback: () => string = m.apps_error_update,
): {
  field: AppInputField | null;
  /** The Installation setup field the refusal names, shown beside it. */
  setupField?: AppSetupField;
  message: string;
} {
  if (!isAppError(cause)) return { field: null, message: fallback() };
  if (isAppErrorCode(cause, "CONFLICT") && cause.errorId === "app-key-taken")
    return { field: "key", message: m.apps_error_key_taken() };
  if (isPermissionsChanged(cause)) return { field: null, message: m.apps_permissions_changed() };
  const field = isAppErrorCode(cause, "INVALID_INPUT") ? appInputFieldOf(cause.errorId) : undefined;
  if (field) return { field, message: APP_FIELD_PROBLEMS[field]() };
  const setupField = isAppErrorCode(cause, "INVALID_INPUT")
    ? setupFieldOf(cause.errorId)
    : undefined;
  if (setupField)
    return {
      field: null,
      setupField,
      message: SETUP_FIELD_PROBLEMS[setupField](),
    };
  if (isAppErrorCode(cause, "ACCESS_DENIED"))
    return { field: null, message: m.apps_error_access_denied() };
  if (isAppErrorCode(cause, "NOT_FOUND")) return { field: null, message: m.apps_error_not_found() };
  return { field: null, message: fallback() };
}

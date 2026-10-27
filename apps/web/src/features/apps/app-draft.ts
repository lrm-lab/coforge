import type { AppCategory } from "./app-category";
import {
  APP_FIXED_SCOPES,
  APP_SCOPES,
  isRedirectUri,
  type AppRegistrationInput,
} from "./app-registration";
import type { AppSummary } from "./apps.functions";

/** The editor's fields as typed, before they are trimmed into an input: a homepage left out is an
 * empty field. */
export type AppDraft = Omit<AppRegistrationInput, "homepageUrl" | "agentManifestUrl"> & {
  homepageUrl: string;
  agentManifestUrl: string;
};

export const EMPTY_APP_DRAFT: AppDraft = {
  key: "",
  name: "",
  description: "",
  whenToUse: "",
  homepageUrl: "",
  agentManifestUrl: "",
  redirectUris: [""],
  category: "other" satisfies AppCategory,
  allowedScopes: [...APP_FIXED_SCOPES],
};

export function draftOf(app: AppSummary): AppDraft {
  return {
    key: app.key,
    name: app.name,
    description: app.description,
    whenToUse: app.whenToUse,
    homepageUrl: app.homepageUrl ?? "",
    agentManifestUrl: app.agentManifestUrl ?? "",
    redirectUris: app.redirectUris.length > 0 ? app.redirectUris : [""],
    category: app.category,
    allowedScopes: app.allowedScopes,
  };
}

/** What the draft sends: text trimmed, a blank homepage as none, blank redirect rows left out,
 * scopes in their order. */
export function inputOf(draft: AppDraft): AppRegistrationInput {
  return {
    key: draft.key.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    whenToUse: draft.whenToUse.trim(),
    homepageUrl: draft.homepageUrl.trim() || null,
    agentManifestUrl: draft.agentManifestUrl.trim() || null,
    redirectUris: draft.redirectUris.map((uri) => uri.trim()).filter(Boolean),
    category: draft.category,
    allowedScopes: APP_SCOPES.filter((scope) => draft.allowedScopes.includes(scope)),
  };
}

/** The redirect rows the rule refuses on their own, or as a repeat of an earlier row. */
export function refusedRedirectRows(rows: string[]): Set<number> {
  const uris = rows.map((row) => row.trim());
  return new Set(
    uris.flatMap((uri, index) =>
      uri && (!isRedirectUri(uri) || uris.indexOf(uri) !== index) ? [index] : [],
    ),
  );
}

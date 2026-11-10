import { RUNTIME_ERROR_CLASS } from "./runtime-error-vocabulary";
import type {
  ClassifiedRuntimeErrorAction,
  RuntimeErrorClassification,
} from "./runtime-error-classification";

/** Why an Agent's provider credential is known invalid: a login only a person can redo, a plan
 * without the configured model, or an exhausted balance. */
export type CredentialInvalidReason =
  | Exclude<ClassifiedRuntimeErrorAction, "none">
  | typeof RUNTIME_ERROR_CLASS.BILLING;

/**
 * The reason a classified runtime failure shows the credential cannot be used until a person
 * changes something, or undefined for any other failure. The reference Computer holds the Agent's
 * deliveries behind such a failure (`credentialInvalidHold`) instead of taking it offline; a
 * quota with no known reset, a sticky model-config failure and a fingerprint fence still do.
 */
export function credentialInvalidReason(
  classification: Pick<RuntimeErrorClassification, "errorClass" | "requiredAction">,
): CredentialInvalidReason | undefined {
  if (classification.errorClass === RUNTIME_ERROR_CLASS.BILLING) return RUNTIME_ERROR_CLASS.BILLING;
  return classification.requiredAction === "none" ? undefined : classification.requiredAction;
}

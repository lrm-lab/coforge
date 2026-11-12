import type { CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";
import { MAX_MODEL_TOKENS } from "#src/features/computers/computer-model-metadata";

/** The inventory a Computer sends must be one catalog per runtime with bounded model fields; a
 * model's reasoning levels may be absent while the runtime's read is pending. */
export function validModelCatalogs(catalogs: CodeAgentModelCatalog[]): boolean {
  if (new Set(catalogs.map((catalog) => catalog.provider)).size !== catalogs.length) return false;
  return catalogs.every((catalog) =>
    catalog.models.every(
      (model) =>
        model.id.length > 0 &&
        model.id.length <= 200 &&
        model.displayName.length <= 200 &&
        model.description.length <= 2_000 &&
        model.modelProvider.length <= 100 &&
        model.defaultReasoning.length <= 100 &&
        (model.reasoningEfforts ?? []).length <= 20 &&
        (model.reasoningEfforts ?? []).every(
          (effort) => effort.length > 0 && effort.length <= 100,
        ) &&
        // A size, when the provider reports one, that a model could actually have (task #30):
        // anything else is dropped by the decoder and must not pass validation as a number.
        (model.contextWindow === undefined || plausibleTokens(model.contextWindow)) &&
        (model.maxOutputTokens === undefined || plausibleTokens(model.maxOutputTokens)),
    ),
  );
}

function plausibleTokens(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_MODEL_TOKENS;
}

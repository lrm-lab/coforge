import { MAX_MODEL_TOKENS } from "#src/features/computers/computer-model-metadata";

/** The Agent form's two size fields, as the person typed them: empty means "the model's own". */
export type ModelSizes = Readonly<{ contextWindow: string; maxOutputTokens: string }>;

/** A saved config's sizes as the fields show them: nothing filled in stays empty. */
export function initialModelSizes(initial?: {
  contextWindow?: number;
  maxOutputTokens?: number;
}): ModelSizes {
  return {
    contextWindow: initial?.contextWindow === undefined ? "" : String(initial.contextWindow),
    maxOutputTokens: initial?.maxOutputTokens === undefined ? "" : String(initial.maxOutputTokens),
  };
}

/** What one size field carries on submit: absent when left empty, and never a nonsense number. */
export function submittedModelSize(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_MODEL_TOKENS
    ? parsed
    : undefined;
}

/** Whether a size field holds something that is not a size, so the dialog can refuse the save. */
export function modelSizeInvalid(value: string): boolean {
  return value.trim() !== "" && submittedModelSize(value) === undefined;
}

/** Whether the form's sizes differ from the saved ones: what a Save would change, if anything. */
export function modelSizesDirty(
  sizes: ModelSizes,
  initial?: { contextWindow?: number; maxOutputTokens?: number },
): boolean {
  return (
    submittedModelSize(sizes.contextWindow) !== initial?.contextWindow ||
    submittedModelSize(sizes.maxOutputTokens) !== initial?.maxOutputTokens
  );
}

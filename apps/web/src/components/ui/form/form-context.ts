import { createFormHookContexts } from "@tanstack/react-form";

export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();

export function formErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || undefined;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      const trimmed = message.trim();
      return trimmed || undefined;
    }
  }
  return undefined;
}

export function firstFieldError(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    const message = formErrorMessage(error);
    if (message) return message;
  }
  return undefined;
}

export function visibleFieldError(
  meta: {
    isTouched: boolean;
    errors: readonly unknown[];
    errorMap?: Record<string, unknown>;
  },
  submissionAttempts: number,
): string | undefined {
  const hasSubmitError = Boolean(meta.errorMap?.onSubmit || meta.errorMap?.onServer);
  if (!hasSubmitError && !meta.isTouched && submissionAttempts === 0) return undefined;
  return firstFieldError(meta.errors);
}

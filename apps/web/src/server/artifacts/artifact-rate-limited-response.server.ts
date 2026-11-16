import { ARTIFACT_RATE_LIMITED_ERROR_ID } from "#src/features/artifacts/artifact-rate-limited";
import { AppError } from "#src/lib/app-error";

export const artifactRateLimited = (retryAfterSeconds: number) =>
  new AppError("TEMPORARILY_UNAVAILABLE", {
    errorId: ARTIFACT_RATE_LIMITED_ERROR_ID,
    details: { retryAfterSeconds },
  });

export function artifactRateLimitedResponse(input: {
  retryAfterSeconds: number;
  error?: string;
  details?: Record<string, unknown>;
}): Response {
  return Response.json(
    {
      ...(input.error === undefined ? {} : { error: input.error }),
      code: "RATE_LIMITED",
      retryable: true,
      details: { ...input.details, retryAfterSeconds: input.retryAfterSeconds },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(input.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}

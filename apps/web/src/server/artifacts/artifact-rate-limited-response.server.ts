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

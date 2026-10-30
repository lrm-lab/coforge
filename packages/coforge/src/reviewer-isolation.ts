import { CliError } from "#src/cli-error";

/** Whether `COFORGE_REVIEWER_ISOLATION` turns reviewer isolation on for every write. */
export function reviewerIsolationFromEnvironment(): boolean {
  const raw = Bun.env.COFORGE_REVIEWER_ISOLATION;
  const value = raw?.trim().toLowerCase();
  if (!value || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new CliError({
    code: "INVALID_ARG",
    message: `COFORGE_REVIEWER_ISOLATION must be one of: 1, true, 0, false; got ${raw}`,
    retryable: false,
  });
}

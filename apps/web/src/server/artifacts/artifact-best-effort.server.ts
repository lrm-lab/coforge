import { errorType } from "#src/server/errors/error-type.server";

export function warnBestEffort(event: string, error: unknown) {
  console.warn(JSON.stringify({ event, error_type: errorType(error) }));
}

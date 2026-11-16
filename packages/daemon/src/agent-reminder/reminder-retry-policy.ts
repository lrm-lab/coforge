export const RETRY_BUDGET_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 8;

export function retryBackoff(attempt: number) {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

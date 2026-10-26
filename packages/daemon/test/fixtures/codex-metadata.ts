import { CODEX_MODEL_LIST } from "./codex-models";

const usageUnavailable = process.argv.includes("usage-unavailable");
const usageUnsupported = process.argv.includes("usage-unsupported");
const usageTimeout = process.argv.includes("usage-timeout");
const usageApikeyAccount = process.argv.includes("usage-apikey");
const usageNoauthAccount = process.argv.includes("usage-noauth");
const usageLegacyAccount = process.argv.includes("usage-legacy");
const usageAuthRequired = process.argv.includes("usage-auth");
const usageRatelimited = process.argv.includes("usage-ratelimited");
const usageEmpty = process.argv.includes("usage-empty");
const usageExtra = process.argv.includes("usage-extra");

/** Read-only account, usage and catalog scenarios, independent of the fixture's turn state. */
export function handleCodexMetadata(
  request: { id?: string; method: string },
  initialized: boolean,
  usageClient: boolean,
  write: (record: unknown) => void,
): boolean {
  if (request.method === "account/read" && request.id && usageClient) {
    if (usageLegacyAccount) {
      write({ id: request.id, error: { code: -32601, message: "method not found" } });
      return true;
    }
    if (usageApikeyAccount) {
      write({ id: request.id, result: { account: { type: "apiKey" } } });
      return true;
    }
    if (usageNoauthAccount) {
      write({
        id: request.id,
        result: {
          account: { type: "chatgpt", email: "codexuser@example.com" },
          requiresOpenaiAuth: false,
        },
      });
      return true;
    }
    write({
      id: request.id,
      result: { account: { type: "chatgpt", email: "codexuser@example.com" } },
    });
    return true;
  }
  if (request.method === "account/rateLimits/read" && request.id) {
    if (usageTimeout) return true;
    if (usageEmpty) {
      write({ id: request.id, result: {} });
      return true;
    }
    if (usageAuthRequired) {
      write({
        id: request.id,
        error: { code: -32001, message: "authentication required" },
      });
      return true;
    }
    if (usageUnavailable || usageUnsupported) {
      write({
        id: request.id,
        error: { code: "not_logged_in", message: "not logged in" },
      });
      return true;
    }
    const primary = {
      usedPercent: usageRatelimited ? 100 : 25,
      windowDurationMins: 300,
      resetsAt: 1_735_780_800,
    };
    const secondary = {
      usedPercent: 75,
      windowDurationMins: 10_080,
      resetsAt: "2026-01-09T00:00:00.000Z",
    };
    const codexLimit = usageExtra
      ? {
          limitId: "codex",
          limitName: "Codex",
          primary,
          secondary,
          credits: { hasCredits: true, unlimited: false, balance: "12.50" },
          individualLimit: {
            limit: "10",
            used: "3",
            remainingPercent: 40,
            resetsAt: 1_735_780_800,
          },
        }
      : { limitId: "codex", primary, secondary };
    write({
      id: request.id,
      result: {
        planType: "plus",
        rateLimits: codexLimit,
        ...(usageExtra
          ? {
              rateLimitsByLimitId: {
                codex: codexLimit,
                "gpt-5": {
                  limitId: "gpt-5",
                  limitName: "GPT-5",
                  primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_735_780_800 },
                },
              },
            }
          : {}),
      },
    });
    return true;
  }
  if (request.method === "model/list" && request.id && initialized) {
    if (process.argv.includes("catalog-invalid")) {
      write({ id: request.id, result: { data: "fixture-private-payload" } });
      return true;
    }
    if (process.argv.includes("catalog-exit")) process.exit(23);
    if (process.argv.includes("catalog-timeout")) return true;
    if (process.argv.includes("catalog-error")) {
      console.error("401 Unauthorized: Bearer fixture-private-token");
      write({ id: request.id, error: { code: -32001, message: "token=fixture-private-token" } });
      return true;
    }
    write({ id: request.id, result: CODEX_MODEL_LIST });
    return true;
  }
  return false;
}

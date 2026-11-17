import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { asRecord, within } from "@lrm/coforge-anvil";
import { type JsonlProcess } from "@lrm/coforge-anvil/execution";
import { RuntimeModelNotFoundError } from "#src/contract";

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

/** Each bounded wait: `account/read`, then each `model/list` page. */
const ACCOUNT_MODEL_TIMEOUT_MS = 10_000;

type AccountModels = { ids: ReadonlySet<string>; recommended: string | undefined };

/**
 * The models a ChatGPT sign-in may use, from Codex's own account-aware `model/list` (hidden models
 * included: they are still accepted). `undefined` when the sign-in is not ChatGPT or the list
 * cannot be read, so nothing is decided on a guess.
 */
async function chatGptAccountModels(process: JsonlProcess): Promise<AccountModels | undefined> {
  try {
    const account = await within(
      process.request({ method: "account/read", params: {} }),
      ACCOUNT_MODEL_TIMEOUT_MS,
    );
    if (asRecord(asRecord(account.result)?.account)?.type !== "chatgpt") return undefined;
    const ids = new Set<string>();
    let recommended: string | undefined;
    let cursor: string | undefined;
    do {
      const response = await within(
        process.request({
          method: "model/list",
          params: { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
        }),
        ACCOUNT_MODEL_TIMEOUT_MS,
      );
      const result = asRecord(response.result);
      if (!Array.isArray(result?.data)) return undefined;
      for (const entry of result.data) {
        const model = asRecord(entry);
        if (typeof model?.model !== "string") continue;
        ids.add(model.model);
        if (model.isDefault === true && model.hidden !== true) recommended = model.model;
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);
    return ids.size ? { ids, recommended } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex accepts any model when a thread opens and only fails its first turn when a ChatGPT
 * account cannot use it (`codexErrorInfo: "modelNotFound"`), so the opened thread's model is
 * checked against the account here. A model the Agent chose itself is never replaced: the launch
 * fails as `model_not_found` and the person picks another. With no model chosen, the one Codex
 * fell back to (`config.toml` or its built-in default) is kept when the account can use it, and
 * otherwise replaced by the account's own default, returned for `turn/start` (which keeps it for
 * the turns after). Only the `openai` provider's list describes the account.
 */
export async function codexAccountModel(
  process: JsonlProcess,
  opened: Readonly<Record<string, unknown>> | undefined,
  chosen: string | undefined,
  log: Readonly<{ agent_id?: string; runtime_id?: string }>,
): Promise<string | undefined> {
  const model = opened?.model;
  if (typeof model !== "string" || opened?.modelProvider !== "openai") return undefined;
  const account = await chatGptAccountModels(process);
  if (!account || account.ids.has(model)) return undefined;
  if (chosen) throw new RuntimeModelNotFoundError(model);
  if (!account.recommended) return undefined;
  logger.info("Codex default model is not available to this account; using the account default", {
    event: "codex.model.account_fallback",
    ...log,
    configured_model: model,
    model: account.recommended,
  });
  return account.recommended;
}

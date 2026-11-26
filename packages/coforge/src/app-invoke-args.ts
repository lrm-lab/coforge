import type { AppInvokeInvocation } from "./app-actions";
import { cliFlagBadToken, parseCliFlags } from "./cli-flags";

export function parseInvokeArgs(
  rest: readonly string[],
  invalid: (message: string) => never,
  parseTimeout: (raw: string) => number,
): AppInvokeInvocation {
  const [appKey, ...options] = rest;
  if (!appKey || appKey.startsWith("--")) invalid("coforge app invoke needs an app key");
  const { values, positionals } = parseCliFlags({
    args: options,
    options: {
      "list-actions": { type: "boolean" },
      json: { type: "boolean" },
      preflight: { type: "boolean" },
      action: { type: "string" },
      target: { type: "string" },
      timeout: { type: "string" },
      param: { type: "string", multiple: true, allowFlagValue: true },
      "data-json": { type: "string" },
      "data-file": { type: "string" },
      "idempotency-key": { type: "string" },
    },
    maxPositionals: 1,
    rejectFlagValues: true,
    onError(error) {
      if (error.kind === "missing-value") invalid(`${error.flag} needs a value`);
      invalid(`Unexpected argument ${cliFlagBadToken(error)}`);
    },
  });
  const positional = positionals[0];
  const invocation: AppInvokeInvocation = {
    command: "app-invoke",
    appKey,
    ...(values["list-actions"] ? { listActions: true as const } : {}),
    ...(values.json ? { json: true as const } : {}),
    ...(values.preflight ? { preflight: true as const } : {}),
    ...(values.action !== undefined ? { action: values.action } : {}),
    ...(values.target !== undefined ? { target: values.target } : {}),
    ...(values.timeout !== undefined ? { timeoutSeconds: parseTimeout(values.timeout) } : {}),
    ...(values.param?.length ? { params: values.param } : {}),
    ...(values["data-json"] !== undefined ? { dataJson: values["data-json"] } : {}),
    ...(values["data-file"] !== undefined ? { dataFile: values["data-file"] } : {}),
    ...(values["idempotency-key"] !== undefined
      ? { idempotencyKey: values["idempotency-key"] }
      : {}),
  };
  if (positional !== undefined) {
    if (invocation.action !== undefined) invalid("Name the action once: positionally or --action");
    invocation.action = positional;
  }
  if (invocation.listActions) {
    if (positional !== undefined) invalid("With --list-actions, name one action with --action");
    const callOnly = invocation.preflight || invocation.target || invocation.timeoutSeconds;
    if (
      callOnly ||
      invocation.params ||
      invocation.dataJson ||
      invocation.dataFile ||
      invocation.idempotencyKey
    )
      invalid("--list-actions takes only --action and --json");
  } else if (!invocation.action) {
    invalid("coforge app invoke needs an action name, or --list-actions to see what an app offers");
  }
  return invocation;
}

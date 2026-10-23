import type { AppInvokeInvocation } from "./app-actions";

/** Options of `app invoke` that take a value. */
const VALUE_OPTIONS = [
  "--action",
  "--target",
  "--timeout",
  "--param",
  "--data-json",
  "--data-file",
  "--idempotency-key",
] as const;

/**
 * `coforge app invoke <app-key> [<action>] [options]`, without the leading `app invoke`. The
 * action is positional (or `--action`); `--list-actions` shows what an app offers instead.
 * `invalid` throws the command's usage error; `parseTimeout` is the `--timeout` rule shared with
 * `app token`.
 */
export function parseInvokeArgs(
  rest: readonly string[],
  invalid: (message: string) => never,
  parseTimeout: (raw: string) => number,
): AppInvokeInvocation {
  const [appKey, ...options] = rest;
  if (!appKey || appKey.startsWith("--")) invalid("coforge app invoke needs an app key");
  const invocation: AppInvokeInvocation = { command: "app-invoke", appKey };
  let positional: string | undefined;
  for (let index = 0; index < options.length; index++) {
    const option = options[index]!;
    if (option === "--list-actions") invocation.listActions = true;
    else if (option === "--json") invocation.json = true;
    else if (option === "--preflight") invocation.preflight = true;
    else if ((VALUE_OPTIONS as readonly string[]).includes(option)) {
      const value = options[++index];
      if (value === undefined || (value.startsWith("--") && option !== "--param"))
        invalid(`${option} needs a value`);
      if (option === "--action") invocation.action = value;
      else if (option === "--target") invocation.target = value;
      else if (option === "--timeout") invocation.timeoutSeconds = parseTimeout(value);
      else if (option === "--param") (invocation.params ??= []).push(value);
      else if (option === "--data-json") invocation.dataJson = value;
      else if (option === "--data-file") invocation.dataFile = value;
      else invocation.idempotencyKey = value;
    } else if (!option.startsWith("--") && positional === undefined) positional = option;
    else invalid(`Unexpected argument ${option}`);
  }
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

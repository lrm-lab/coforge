import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

/**
 * The OpenCode CLI baseline this runtime launches against.
 *
 * OpenCode v2 is the supported CLI contract. Its `opencode run` command provides the machine
 * interface this adapter consumes (`--format json`, `--auto`, `--model provider/model#variant`,
 * and `--session`), with the working directory set through cwd/PWD. V1 is no longer a supported
 * runtime surface. An older build can silently print
 * its usage and exit 0 when handed a flag it does not know. The v2 command
 * and event shape are documented at https://opencode.ai/v2/docs/cli/commands/.
 *
 * 2.0.30 is the first release whose instruction plugin loads absolute `instructions` entries from
 * every config document, including the `OPENCODE_CONFIG_CONTENT` document. On 2.0.0 through
 * 2.0.29 the child still starts and the standing briefing is silently dropped. That append is not
 * true for the whole 2.0 line, so the floor is 2.0.30 rather than every v2 build.
 */
export const OPENCODE_MIN_CLI_VERSION = "2.0.30";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.OPENCODE,
  label: "OpenCode",
  executable: RUNTIME_PROVIDER.OPENCODE,
  minimum: OPENCODE_MIN_CLI_VERSION,
});

export const isOpenCodeVersionUnsupported = gate.isUnsupported;
export const logOpenCodeVersionUnsupported = gate.logUnsupported;
export const assertOpenCodeVersionSupported = gate.assertSupported;

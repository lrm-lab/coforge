import { readLines } from "./read-lines";

/**
 * A fake Claude Code for the `list_models` control request. The daemon must spawn it with the argv
 * `CLAUDE_CODE_CATALOG_ARGUMENTS` names; anything else exits non-zero. It answers the way the
 * measured CLI does: one unrelated `system` line, then the `control_response`. `list-models-error`
 * answers with a non-success subtype, `list-models-silent` never answers, and `list-models-exit`
 * exits on the request without answering.
 */
const EXPECTED_ARGUMENTS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--settings",
  '{"disableAllHooks":true}',
];
const MODES = new Set(["list-models-silent", "list-models-error", "list-models-exit"]);
const args = process.argv.slice(2);
const modes = args.slice(EXPECTED_ARGUMENTS.length);
if (
  EXPECTED_ARGUMENTS.some((argument, index) => args[index] !== argument) ||
  modes.some((mode) => !MODES.has(mode))
)
  process.exit(2);

const silent = modes.includes("list-models-silent");
const failing = modes.includes("list-models-error");
const exiting = modes.includes("list-models-exit");

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function model(
  value: string,
  resolvedModel: string,
  displayName: string,
  supportsFastMode: boolean,
) {
  return {
    value,
    resolvedModel,
    displayName,
    supportedEffortLevels: EFFORTS,
    ...(supportsFastMode ? { supportsFastMode: true } : {}),
  };
}

const MODELS = [
  model("default", "claude-opus-5-5", "Default (recommended)", true),
  model("opus", "claude-opus-5-5", "Opus", true),
  model("claude-opus-5", "claude-opus-5", "Opus 5", true),
  model("claude-opus-4-8", "claude-opus-4-8", "Opus 4.8", true),
  model("claude-opus-4-7", "claude-opus-4-7", "Opus 4.7", false),
  model("sonnet", "claude-sonnet-5-5", "Sonnet", false),
  model("fable", "claude-fable-5-1", "Fable", false),
  model("haiku", "claude-haiku-5-5", "Haiku", false),
];

function emit(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

for await (const line of readLines(Bun.stdin.stream())) {
  const text = line.trim();
  if (!text) continue;
  const message = JSON.parse(text) as {
    type?: unknown;
    request_id?: unknown;
    request?: { subtype?: unknown };
  };
  if (message.type !== "control_request" || message.request?.subtype !== "list_models") continue;
  if (silent) continue;
  if (exiting) process.exit(0);
  emit({ type: "system", subtype: "init", session_id: "fixture-session" });
  emit({
    type: "control_response",
    response: failing
      ? { subtype: "error", request_id: message.request_id, error: "list models failed" }
      : {
          subtype: "success",
          request_id: message.request_id,
          response: { models: MODELS },
        },
  });
}

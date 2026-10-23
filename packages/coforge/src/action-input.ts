import { isRecord } from "@lrm/coforge-sdk/internal";
import type { AgentManifestAction } from "@lrm/coforge-sdk/agent";
import { readCappedText } from "./capped-read";
import { CliError } from "./cli-error";

/** What the Agent gave as input: `--param` pairs, or one JSON document (text, file or stdin). */
export type ActionInputSources = {
  params?: readonly string[];
  dataJson?: string;
  dataFile?: string;
};

export type ActionInputIo = {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
};

/** Input read from a file or from standard input is at most this long. */
export const INPUT_MAX_BYTES = 1024 * 1024;
/** A decimal literal: optional minus, digits with an optional fraction, optional exponent. */
const DECIMAL_NUMBER = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/** The stream's text, refusing more than 1 MiB. */
export async function readCappedStdin(
  stream: ReadableStream<Uint8Array> = Bun.stdin.stream(),
): Promise<string> {
  const text = await readCappedText(stream, INPUT_MAX_BYTES);
  if (text === null) throw new Error("larger than 1 MiB");
  return text;
}

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

const bad = (message: string, outputMode: "text" | "json") =>
  new CliError({
    code: "INPUT_INVALID",
    message,
    retryable: false,
    suggestedNextAction:
      "Fix the input and run the command again; coforge app invoke <app-key> --list-actions --action <name> shows what the action takes.",
    outputMode,
  });

function propertyType(action: AgentManifestAction, name: string): string | undefined {
  const properties = action.input_schema.properties;
  const schema =
    isRecord(properties) && Object.hasOwn(properties, name) ? properties[name] : undefined;
  return isRecord(schema) && typeof schema.type === "string" ? schema.type : undefined;
}

/** A `--param` text as the type the schema declares for it. */
function coerce(name: string, text: string, type: string | undefined): unknown {
  switch (type) {
    case "integer": {
      const value = Number(text);
      if (/^-?\d+$/.test(text) && Number.isSafeInteger(value)) return value;
      throw new Error(`--param ${name} must be an integer`);
    }
    case "number": {
      const value = Number(text);
      if (DECIMAL_NUMBER.test(text) && Number.isFinite(value)) return value;
      throw new Error(`--param ${name} must be a number`);
    }
    case "boolean":
      if (text === "true" || text === "false") return text === "true";
      throw new Error(`--param ${name} must be true or false`);
    case "array":
    case "object":
      throw new Error(`--param ${name} is ${type}-valued: give it with --data-json or --data-file`);
    default:
      return text;
  }
}

/**
 * The action's input object from the Agent's sources: `--param key=value` (a value `@path` is that
 * file's text, `@-` is stdin) coerced by the schema's declared type, or one JSON object. The two
 * styles are exclusive. The result is not yet checked against the schema.
 */
export async function resolveActionInput(
  action: AgentManifestAction,
  sources: ActionInputSources,
  io: ActionInputIo,
  outputMode: "text" | "json",
): Promise<Record<string, unknown>> {
  const fail = (message: string) => bad(message, outputMode);
  const styles = [sources.params?.length, sources.dataJson, sources.dataFile].filter(
    (style) => style !== undefined && style !== 0,
  );
  if (styles.length > 1)
    throw fail("Give the input one way: --param, --data-json or --data-file, not several");
  let stdinUsed = false;
  const stdin = async () => {
    if (stdinUsed) throw fail("Standard input can be read only once");
    stdinUsed = true;
    return io.readStdin();
  };
  const readSource = async (path: string, label: string) => {
    try {
      return path === "-" ? await stdin() : await io.readFile(path);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw fail(`Cannot read ${label} ${path}`);
    }
  };
  const parseObject = (text: string, label: string) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw fail(`${label} is not valid JSON`);
    }
    if (!isRecord(value) || Array.isArray(value)) throw fail(`${label} must be a JSON object`);
    return value;
  };
  if (sources.dataJson !== undefined) return parseObject(sources.dataJson, "--data-json");
  if (sources.dataFile !== undefined)
    return parseObject(await readSource(sources.dataFile, "--data-file"), "--data-file");
  const input: Record<string, unknown> = {};
  for (const param of sources.params ?? []) {
    const at = param.indexOf("=");
    if (at < 1) throw fail(`--param takes key=value, not "${param.slice(0, 40)}"`);
    const name = param.slice(0, at);
    if (RESERVED.has(name)) throw fail(`--param ${name} is not an allowed input name`);
    if (Object.hasOwn(input, name)) throw fail(`--param ${name} is given twice`);
    let text = param.slice(at + 1);
    if (text.startsWith("@")) text = await readSource(text.slice(1), `--param ${name} file`);
    try {
      input[name] = coerce(name, text, propertyType(action, name));
    } catch (error) {
      throw fail(error instanceof Error ? error.message : String(error));
    }
  }
  return input;
}

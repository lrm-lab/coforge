import { invalidArgument } from "#src/command-help/index";
import { cliFlagBadToken, parseCliFlags, type CliFlagOptions } from "./cli-flags";

export type FlagSpec = {
  text?: readonly string[];
  count?: readonly string[];
  bool?: readonly string[];
  repeat?: readonly string[];
  positionals?: number;
};

export type ParsedFlags = {
  positionals: string[];
  text: Record<string, string>;
  count: Record<string, number>;
  repeated: string[];
  switches: Set<string>;
  json: boolean;
};

const stripFlagPrefix = (flag: string) => (flag.startsWith("--") ? flag.slice(2) : flag);

export function parseFlags(command: string, args: readonly string[], spec: FlagSpec): ParsedFlags {
  const options: CliFlagOptions = { json: { type: "boolean" } };
  for (const flag of spec.bool ?? []) options[stripFlagPrefix(flag)] = { type: "boolean" };
  for (const flag of spec.text ?? []) options[stripFlagPrefix(flag)] = { type: "string" };
  for (const flag of spec.count ?? []) options[stripFlagPrefix(flag)] = { type: "string" };
  for (const flag of spec.repeat ?? [])
    options[stripFlagPrefix(flag)] = { type: "string", multiple: true };

  const { values, positionals } = parseCliFlags({
    args,
    options,
    maxPositionals: spec.positionals ?? 0,
    duplicates: "error-strings",
    onError(error) {
      if (error.kind === "missing-value")
        throw invalidArgument(command, `${error.flag} needs a value`);
      if (error.kind === "duplicate")
        throw invalidArgument(command, `${error.flag} is given twice`);
      throw invalidArgument(command, `Unexpected argument ${cliFlagBadToken(error)}`);
    },
  });

  const flags: ParsedFlags = {
    positionals,
    text: {},
    count: {},
    repeated: [],
    switches: new Set<string>(),
    json: values.json === true,
  };
  for (const flag of spec.bool ?? []) {
    if (values[stripFlagPrefix(flag)] === true) flags.switches.add(flag);
  }
  for (const flag of spec.text ?? []) {
    const value = values[stripFlagPrefix(flag)] as string | undefined;
    if (value !== undefined) flags.text[flag] = value;
  }
  for (const flag of spec.count ?? []) {
    const value = values[stripFlagPrefix(flag)] as string | undefined;
    if (value !== undefined) {
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw invalidArgument(command, `${flag} takes a whole number, not "${value}"`);
      flags.count[flag] = Number(value);
    }
  }
  for (const flag of spec.repeat ?? []) {
    const list = values[stripFlagPrefix(flag)] as string[] | undefined;
    if (list) flags.repeated.push(...list);
  }
  return flags;
}

export const optional = <T>(key: string, value: T | undefined) =>
  value === undefined ? {} : { [key]: value };

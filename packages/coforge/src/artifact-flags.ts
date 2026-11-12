import { invalidArgument } from "#src/command-help/index";

/**
 * The flags of a `coforge artifact` command: `text` ones take a string, `count` ones a whole number
 * (a version, a limit), `bool` ones nothing, `repeat` ones may be given again, and `positionals` is
 * how many bare arguments it takes at most. What a value means is for the server to judge.
 */
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

/** Reads `args` (after the operation) against `spec`; `--json` is every command's. */
export function parseFlags(command: string, args: readonly string[], spec: FlagSpec): ParsedFlags {
  const flags: ParsedFlags = {
    positionals: [],
    text: {},
    count: {},
    repeated: [],
    switches: new Set<string>(),
    json: false,
  };
  const has = (list: readonly string[] | undefined, arg: string) => list?.includes(arg) === true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") flags.json = true;
    else if (has(spec.bool, arg)) flags.switches.add(arg);
    else if (!arg.startsWith("--")) {
      if (flags.positionals.length >= (spec.positionals ?? 0))
        throw invalidArgument(command, `Unexpected argument ${arg}`);
      flags.positionals.push(arg);
    } else {
      if (!has(spec.text, arg) && !has(spec.count, arg) && !has(spec.repeat, arg))
        throw invalidArgument(command, `Unexpected argument ${arg}`);
      const value = args[index + 1];
      if (value === undefined) throw invalidArgument(command, `${arg} needs a value`);
      index += 1;
      if (has(spec.repeat, arg)) flags.repeated.push(value);
      else if (arg in flags.text || arg in flags.count)
        throw invalidArgument(command, `${arg} is given twice`);
      else if (has(spec.count, arg)) {
        if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw invalidArgument(command, `${arg} takes a whole number, not "${value}"`);
        flags.count[arg] = Number(value);
      } else flags.text[arg] = value;
    }
  }
  return flags;
}

/** `{ [key]: value }`, or nothing for an unset value: for spreading a request's optional fields. */
export const optional = <T>(key: string, value: T | undefined) =>
  value === undefined ? {} : { [key]: value };
